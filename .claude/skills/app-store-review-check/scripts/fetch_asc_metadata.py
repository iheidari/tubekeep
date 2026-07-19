#!/usr/bin/env python3
"""Fetch app metadata and TestFlight builds from the App Store Connect API.

Requires the user's own App Store Connect API key (generated in App Store Connect ->
Users and Access -> Integrations). The key is used only to sign a short-lived JWT
locally; it is never uploaded anywhere except Apple's own API over HTTPS.

Dependencies:
    pip install pyjwt cryptography requests --break-system-packages

Example:
    python fetch_asc_metadata.py \
        --key-id ABC123DEF4 \
        --issuer-id 11111111-2222-3333-4444-555555555555 \
        --key-file AuthKey_ABC123DEF4.p8 \
        --app-id 1234567890 \
        --out asc_metadata.json

If --app-id is omitted, the script lists all apps on the account so you can pick one.
"""
import argparse
import json
import sys
import time

try:
    import jwt  # PyJWT
    import requests
except ImportError:
    sys.exit("Missing deps. Run: pip install pyjwt cryptography requests --break-system-packages")

API = "https://api.appstoreconnect.apple.com/v1"


def make_token(key_id: str, issuer_id: str, key_file: str) -> str:
    with open(key_file, "r") as f:
        private_key = f.read()
    now = int(time.time())
    payload = {
        "iss": issuer_id,
        "iat": now,
        "exp": now + 20 * 60,  # max 20 minutes
        "aud": "appstoreconnect-v1",
    }
    headers = {"kid": key_id, "typ": "JWT"}
    return jwt.encode(payload, private_key, algorithm="ES256", headers=headers)


def get(session: requests.Session, path: str, params: dict | None = None) -> dict:
    url = path if path.startswith("http") else f"{API}{path}"
    r = session.get(url, params=params or {})
    if r.status_code != 200:
        raise SystemExit(f"API error {r.status_code} for {url}:\n{r.text}")
    return r.json()


def list_apps(session: requests.Session) -> list[dict]:
    data = get(session, "/apps", {"limit": 200})
    return [
        {
            "id": a["id"],
            "name": a["attributes"].get("name"),
            "bundleId": a["attributes"].get("bundleId"),
            "sku": a["attributes"].get("sku"),
            "primaryLocale": a["attributes"].get("primaryLocale"),
        }
        for a in data.get("data", [])
    ]


def app_metadata(session: requests.Session, app_id: str) -> dict:
    out = {"app_id": app_id}
    out["app"] = get(session, f"/apps/{app_id}").get("data", {})

    # App Store versions (state, version string, release type)
    versions = get(
        session,
        f"/apps/{app_id}/appStoreVersions",
        {"limit": 10, "include": "appStoreVersionLocalizations"},
    )
    out["appStoreVersions"] = versions.get("data", [])
    out["appStoreVersionLocalizations"] = versions.get("included", [])

    # App info (age rating, category, content-rights)
    try:
        out["appInfos"] = get(session, f"/apps/{app_id}/appInfos").get("data", [])
    except SystemExit:
        out["appInfos"] = []

    # TestFlight builds
    try:
        builds = get(
            session,
            "/builds",
            {"filter[app]": app_id, "limit": 25, "sort": "-uploadedDate"},
        )
        out["testflight_builds"] = builds.get("data", [])
    except SystemExit:
        out["testflight_builds"] = []

    return out


def main() -> None:
    p = argparse.ArgumentParser(description="Fetch App Store Connect app metadata + TestFlight builds.")
    p.add_argument("--key-id", required=True)
    p.add_argument("--issuer-id", required=True)
    p.add_argument("--key-file", required=True, help="Path to the AuthKey_XXXX.p8 file")
    p.add_argument("--app-id", help="App Store app ID. Omit to list all apps.")
    p.add_argument("--out", default="asc_metadata.json")
    args = p.parse_args()

    token = make_token(args.key_id, args.issuer_id, args.key_file)
    session = requests.Session()
    session.headers.update({"Authorization": f"Bearer {token}"})

    if not args.app_id:
        apps = list_apps(session)
        print("Apps on this account (pass one via --app-id):")
        for a in apps:
            print(f"  {a['id']}  {a['name']}  ({a['bundleId']})")
        return

    data = app_metadata(session, args.app_id)
    with open(args.out, "w") as f:
        json.dump(data, f, indent=2)
    print(f"Wrote {args.out}")
    versions = data.get("appStoreVersions", [])
    if versions:
        attrs = versions[0].get("attributes", {})
        print(f"Latest version: {attrs.get('versionString')} — state: {attrs.get('appStoreState')}")


if __name__ == "__main__":
    main()
