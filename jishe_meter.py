import json
import os
import sys
import time

import requests

BASE_URL = "https://yff.jisheyun.com/yzxcx/prod/u/api"
QUERY_URL = f"{BASE_URL}/Customer/Login/GetMeterVistor"
READ_URL = f"{BASE_URL}/kwh/ammter/Reading"

PHONE = os.getenv("JISHE_PHONE", "")
CUSTOMER_ID = os.getenv("JISHE_CUSTOMER_ID", "")
ROOM_ID = os.getenv("JISHE_ROOM_ID", "")
METER_ID = os.getenv("JISHE_METER_ID", "")
SIGN = os.getenv("JISHE_SIGN", "")

COMMON_HEADERS = {
    "User-Agent": "Mozilla/5.0",
    "Accept": "*/*",
    "Token": "",
}


def require(name: str, value: str) -> None:
    if not value:
        raise RuntimeError(f"缺少环境变量：{name}")


def query_meter() -> dict:
    require("JISHE_PHONE", PHONE)

    response = requests.get(
        QUERY_URL,
        params={"phoneNumber": PHONE},
        headers={
            **COMMON_HEADERS,
            "Content-Type": "application/x-www-form-urlencoded",
        },
        timeout=15,
    )
    response.raise_for_status()
    payload = response.json()

    if not payload.get("Code"):
        raise RuntimeError(f"查询失败：{payload}")

    meters = payload.get("Data") or []
    if not meters:
        raise RuntimeError("查询成功，但返回的 Data 为空")

    meter = meters[0]
    return {
        "balance": meter.get("RoomBalance"),
        "kwh": meter.get("ReadKwh"),
        "last_read": meter.get("LastReadTime"),
        "valve": meter.get("ValveState"),
    }


def read_meter() -> dict:
    for name, value in (
        ("JISHE_PHONE", PHONE),
        ("JISHE_CUSTOMER_ID", CUSTOMER_ID),
        ("JISHE_ROOM_ID", ROOM_ID),
        ("JISHE_METER_ID", METER_ID),
        ("JISHE_SIGN", SIGN),
    ):
        require(name, value)

    body = {
        "customerId": int(CUSTOMER_ID),
        "roomId": int(ROOM_ID),
        "meterId": int(METER_ID),
        "phoneNumber": PHONE,
        "sign": SIGN,
    }

    response = requests.post(
        READ_URL,
        json=body,
        headers={**COMMON_HEADERS, "Content-Type": "application/json"},
        timeout=20,
    )
    response.raise_for_status()
    payload = response.json()

    if not payload.get("Code"):
        raise RuntimeError(f"抄读失败：{payload}")

    return payload


def print_status(status: dict) -> None:
    valve = "合闸" if status["valve"] else "断闸"
    print(f"余额：{status['balance']} 元")
    print(f"总用电量：{status['kwh']} kWh")
    print(f"最近抄读：{status['last_read']}")
    print(f"电闸状态：{valve}")


def main() -> None:
    mode = sys.argv[1] if len(sys.argv) > 1 else "query"

    if mode == "query":
        print_status(query_meter())
        return

    if mode == "read":
        result = read_meter()
        print("抄读接口返回：")
        print(json.dumps(result, ensure_ascii=False, indent=2))
        time.sleep(2)
        print("\n最新状态：")
        print_status(query_meter())
        return

    raise SystemExit("用法：python jishe_meter.py query | read")


if __name__ == "__main__":
    main()
