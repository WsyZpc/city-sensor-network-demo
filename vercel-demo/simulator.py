"""模拟一个环境传感器。数值只用于产品演示，不代表真实监测结果。"""

import random
from datetime import datetime, timezone

NODE_ID = "wuhan-demo-001"
INTERVAL_SECONDS = 5


def make_reading(sequence: int, previous: dict | None = None) -> dict:
    """围绕上一条读数小幅变化，生成带序号、时间和单位的模拟读数。"""
    previous = previous or {"pm25_ug_m3": 28.4, "noise_db": 53.2}
    return {
        "node_id": NODE_ID,
        "sequence": sequence,
        "recorded_at": datetime.now(timezone.utc).isoformat(timespec="milliseconds"),
        "pm25_ug_m3": round(min(150, max(2, previous["pm25_ug_m3"] + random.uniform(-2.2, 2.2))), 1),
        "noise_db": round(min(90, max(25, previous["noise_db"] + random.uniform(-2.8, 2.8))), 1),
        "source": "simulated",
    }


if __name__ == "__main__":
    import json

    print(json.dumps(make_reading(1), ensure_ascii=False, indent=2))
