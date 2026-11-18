import os, json, requests
KEY, IDENT, PWD = os.environ["CAPITAL_API_KEY"], os.environ["CAPITAL_IDENTIFIER"], os.environ["CAPITAL_API_PASSWORD"]
base = "https://api-capital.backend-capital.com"
r = requests.post(f"{base}/api/v1/session", headers={"X-CAP-API-KEY": KEY}, json={"identifier": IDENT, "password": PWD, "encryptedPassword": False}, timeout=30)
H = {"X-CAP-API-KEY": KEY, "CST": r.headers["CST"], "X-SECURITY-TOKEN": r.headers["X-SECURITY-TOKEN"]}
for epic in ("OIL_BRENT", "LCOF2027", "LCOG2027", "OIL_CRUDE", "CLF2027", "CLG2027"):
    m = requests.get(f"{base}/api/v1/markets/{epic}", headers=H, timeout=30).json()
    inst, snap, rules = m.get("instrument", {}), m.get("snapshot", {}), m.get("dealingRules", {})
    print("FEE", json.dumps({"epic": epic, "name": inst.get("name"), "expiry": inst.get("expiry"), "overnightFee": inst.get("overnightFee"),
        "bid": snap.get("bid"), "offer": snap.get("offer"), "lotSize": inst.get("lotSize"), "marginFactor": inst.get("marginFactor"),
        "rolloverDetails": inst.get("rolloverDetails")}))
    print("KEYS", epic, sorted(inst.keys()))
