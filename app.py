r"""启动：.\.venv\Scripts\python.exe app.py，然后打开 http://127.0.0.1:8000。"""

import asyncio
import json
import logging
import os
import re
import secrets
from contextlib import asynccontextmanager, suppress
from pathlib import Path

import uvicorn
from fastapi import FastAPI, HTTPException, Query, Request, Response
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, StrictBool

from batches import BATCH_WINDOW_SECONDS, BatchStore
from chain import BotChain, ChainError
from simulator import INTERVAL_SECONDS, NODE_ID
from storage import ReadingStore
from wallet_auth import WalletSessions

ROOT = Path(__file__).resolve().parent
DATA_DIR = Path(os.environ.get("SENSOR_DATA_DIR", str(ROOT / "data")))
store = ReadingStore(DATA_DIR / "sensors.sqlite3")
batches = BatchStore(DATA_DIR / "sensors.sqlite3", DATA_DIR / "batches")
CHAIN_CONFIG = json.loads((ROOT / "templates" / "static" / "chain-config.json").read_text(encoding="utf-8"))
chain = BotChain(CHAIN_CONFIG)
wallet_sessions = WalletSessions()


async def sample_loop(app: FastAPI):
    while True:
        await asyncio.sleep(INTERVAL_SECONDS)
        if app.state.sampling:
            try:
                await asyncio.to_thread(store.capture)
                app.state.sampling_error = False
            except Exception:
                logging.exception("Automatic sampling failed")
                app.state.sampling_error = True


async def batch_loop():
    while True:
        await asyncio.sleep(BATCH_WINDOW_SECONDS)
        try:
            await asyncio.to_thread(batches.seal)
        except Exception:
            logging.exception("Automatic batch sealing failed")


@asynccontextmanager
async def lifespan(app: FastAPI):
    store.initialize()
    batches.initialize()
    store.capture()
    app.state.sampling = True
    app.state.sampling_error = False
    tasks = [asyncio.create_task(sample_loop(app)), asyncio.create_task(batch_loop())]
    try:
        yield
    finally:
        for task in tasks:
            task.cancel()
            with suppress(asyncio.CancelledError):
                await task


app = FastAPI(title="城市传感器网络 · 本地模拟", version="0.1.0", lifespan=lifespan)
app.mount("/static", StaticFiles(directory=ROOT / "templates" / "static", html=True), name="static")


@app.middleware("http")
async def add_utf8_charset(request: Request, call_next):
    response = await call_next(request)
    content_type = response.headers.get("content-type", "")
    if content_type.startswith(("text/html", "text/css", "application/javascript", "application/json")):
        if "charset" not in content_type:
            response.headers["content-type"] = content_type + "; charset=utf-8"
    return response


@app.middleware("http")
async def local_controls(request: Request, call_next):
    # 浏览器控制按钮只接受同源请求；服务仅绑定本机地址。
    origin = request.headers.get("origin")
    if request.method == "POST" and origin and origin != str(request.base_url).rstrip("/"):
        from fastapi.responses import JSONResponse

        return JSONResponse({"detail": "Only same-origin controls are allowed."}, status_code=403)
    response = await call_next(request)
    response.headers["Cache-Control"] = "no-store"
    return response


@app.get("/", include_in_schema=False)
def homepage():
    return FileResponse(ROOT / "templates" / "monitor.html")


@app.get("/subscribe", include_in_schema=False)
def subscribe_page():
    return FileResponse(ROOT / "templates" / "subscribe.html")


@app.get("/verify", include_in_schema=False)
def verify_page():
    return FileResponse(ROOT / "templates" / "verify.html")


def session_address(request: Request) -> str | None:
    return wallet_sessions.get_address(request.cookies.get("sensor_session"))


def required_address(request: Request) -> str:
    address = session_address(request)
    if address is None:
        raise HTTPException(status_code=401, detail="请先连接钱包并签名登录。")
    return address


def set_auth_cookie(response: Response, request: Request, name: str, token: str, max_age: int):
    response.set_cookie(
        name,
        token,
        max_age=max_age,
        path="/api" if name == "sensor_session" else "/api/auth",
        httponly=True,
        secure=request.url.scheme == "https",
        samesite="strict",
    )


@app.get("/api/auth/challenge")
def auth_challenge(address: str, request: Request, response: Response):
    try:
        token, message, expires_in = wallet_sessions.create_challenge(
            address,
            request.url.netloc,
            f"{request.url.scheme}://{request.url.netloc}",
            int(CHAIN_CONFIG["chain_id_decimal"]),
        )
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    set_auth_cookie(response, request, "sensor_challenge", token, expires_in)
    return {"address": wallet_sessions.normalize_address(address), "message": message, "expires_in": expires_in}


class WalletSignature(BaseModel):
    address: str
    signature: str


@app.post("/api/auth/verify")
def auth_verify(body: WalletSignature, request: Request, response: Response):
    try:
        address = wallet_sessions.normalize_address(body.address)
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    token = request.cookies.get("sensor_challenge")
    session = wallet_sessions.consume_challenge(token or "", address, body.signature)
    if session is None:
        raise HTTPException(status_code=401, detail="签名无效或登录请求已过期，请重新连接钱包。")
    set_auth_cookie(response, request, "sensor_session", session, wallet_sessions.ttl_seconds)
    response.delete_cookie("sensor_challenge", path="/api/auth", samesite="strict")
    return {"authenticated": True, "address": address, "expires_in": wallet_sessions.ttl_seconds}


@app.get("/api/auth/me")
def auth_me(request: Request):
    address = session_address(request)
    if address is None:
        return {"authenticated": False}
    return {"authenticated": True, "address": address}


@app.post("/api/auth/logout")
def auth_logout(request: Request, response: Response):
    wallet_sessions.revoke(request.cookies.get("sensor_session"))
    response.delete_cookie("sensor_session", path="/api", samesite="strict")
    return {"authenticated": False}


@app.get("/api/access")
def access_status(request: Request):
    address = session_address(request)
    if address is None:
        return {"authenticated": False, "can_download": False}
    try:
        owner_access = chain.owner().lower() == address.lower()
        subscription = {"valid": False, "stream_id": int(CHAIN_CONFIG["stream_id"])} if owner_access else chain.subscription(address, int(CHAIN_CONFIG["stream_id"]))
    except ChainError as error:
        raise HTTPException(status_code=503, detail=str(error)) from error
    return {"authenticated": True, "address": address, "owner_access": owner_access, "subscription": subscription, "can_download": owner_access or subscription["valid"]}


@app.get("/api/readings")
def readings(request: Request, limit: int = Query(default=3, ge=1, le=500)):
    address = session_address(request)
    preview_only = address is None
    if not preview_only:
        try:
            allowed = chain.owner().lower() == address.lower() or chain.subscription(address, int(CHAIN_CONFIG["stream_id"]))["valid"]
        except ChainError as error:
            raise HTTPException(status_code=503, detail=str(error)) from error
        if not allowed:
            preview_only = True
    if preview_only:
        limit = min(limit, 3)
    return {
        **store.snapshot(limit),
        "node_id": NODE_ID,
        "source": "simulated",
        "sampling": app.state.sampling,
        "sampling_error": app.state.sampling_error,
        "interval_seconds": INTERVAL_SECONDS,
        "anchored": False,
        "preview_only": preview_only,
    }


class SamplingControl(BaseModel):
    running: StrictBool


@app.post("/api/simulator")
def control_simulator(control: SamplingControl):
    app.state.sampling = control.running
    return {"sampling": app.state.sampling}


@app.post("/api/sample", status_code=201)
def sample_once():
    try:
        return store.capture()
    except Exception as error:
        logging.exception("Manual sampling failed")
        raise HTTPException(status_code=503, detail="采样失败，请查看终端日志。") from error


@app.get("/api/batches")
def list_batches(limit: int = Query(default=10, ge=1, le=200)):
    return {"batches": batches.list_recent(limit)}


@app.post("/api/batches/seal", status_code=201)
def seal_batch_now():
    batch = batches.seal()
    if batch is None:
        raise HTTPException(status_code=400, detail="没有未打包的新读数，无需创建批次。")
    return batch


@app.get("/api/batches/{batch_seq}")
def get_batch(batch_seq: int):
    batch = batches.get(batch_seq)
    if batch is None:
        raise HTTPException(status_code=404, detail="批次不存在。")
    return batch


@app.get("/api/batches/{batch_seq}/download")
def download_batch(batch_seq: int, request: Request):
    address = required_address(request)
    try:
        owner_access = chain.owner().lower() == address.lower()
        allowed = owner_access or chain.subscription(address, int(CHAIN_CONFIG["stream_id"]))["valid"]
    except ChainError as error:
        raise HTTPException(status_code=503, detail=str(error)) from error
    if not allowed:
        raise HTTPException(status_code=403, detail="当前钱包没有有效订阅。请前往订阅页购买后再下载。")
    batch = batches.get(batch_seq)
    if batch is None:
        raise HTTPException(status_code=404, detail="批次不存在。")
    path = batches.file_path(batch)
    if not path.exists():
        raise HTTPException(status_code=404, detail="批次文件已丢失。")
    return FileResponse(path, media_type="application/json", filename=batch["file_name"])


@app.get("/api/batches/{batch_seq}/verify")
def verify_batch(batch_seq: int):
    result = batches.verify(batch_seq)
    if result is None:
        raise HTTPException(status_code=404, detail="批次不存在。")
    return result


@app.get("/api/hash/{sha256_hex}")
def find_by_hash(sha256_hex: str):
    batch = batches.find_by_hash(sha256_hex)
    if batch is None:
        raise HTTPException(status_code=404, detail="未找到匹配的哈希记录。")
    return batch


class AnchorRequest(BaseModel):
    tx_hash: str


@app.post("/api/batches/{batch_seq}/anchor", status_code=200)
def anchor_batch(batch_seq: int, req: AnchorRequest):
    batch = batches.get(batch_seq)
    if batch is None:
        raise HTTPException(status_code=404, detail="批次不存在。")
    try:
        proof = chain.verify_record_data_tx(req.tx_hash, batch)
    except ChainError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    result = batches.save_anchor_tx(batch_seq, req.tx_hash, proof)
    if result is None:
        raise HTTPException(status_code=409, detail="存证记录已确认，或交易与该批次不匹配。")
    return {**result, "anchor_proof": proof, "anchor_verified": True}


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=int(os.environ.get("SENSOR_PORT", "8000")))
