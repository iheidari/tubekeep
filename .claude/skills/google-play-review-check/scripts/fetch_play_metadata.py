#!/usr/bin/env python3
"""Fetch store-listing and track/release info from the Google Play Developer API.

Requires the user's own Google Play Developer API service-account key (Play Console ->
Setup -> API access -> a linked Google Cloud project -> a service account granted access
to the app, with the androidpublisher scope). The key is used only to mint a short-lived
access token locally; it is never uploaded anywhere except Google's own API over HTTPS.

NOTE: the Play Developer API does NOT expose the Data safety form, the content-rating
(IARC) answers, or the permissions declarations. Those still have to be pasted/screenshotted.

Dependencies:
    pip install google-auth requests --break-system-packages

Example:
    python fetch_play_metadata.py \
        --service-account service_account.json \
        --package com.example.app \
        --out play_metadata.json

The Play API is edit-based: this script opens a read-only-style edit, reads the listings,
details, and tracks, then abandons the edit (no changes are committed).
"""
import argparse
import json
import sys

try:
    import requests
    from google.oauth2 import service_account
    from google.auth.transport.requests import Request
except ImportError:
    sys.exit("Missing deps. Run: pip install google-auth requests --break-system-packages")

SCOPE = "https://www.googleapis.com/auth/androidpublisher"
API = "https://androidpublisher.googleapis.com/androidpublisher/v3"


def access_token(service_account_file: str) -> str:
    creds = service_account.Credentials.from_service_account_file(
        service_account_file, scopes=[SCOPE]
    )
    creds.refresh(Request())
    return creds.token


def get(session: requests.Session, path: str, params: dict | None = None) -> dict:
    url = path if path.startswith("http") else f"{API}{path}"
    r = session.get(url, params=params or {})
    if r.status_code != 200:
        raise SystemExit(f"API error {r.status_code} for {url}:\n{r.text}")
    return r.json()


def post(session: requests.Session, path: str) -> dict:
    r = session.post(f"{API}{path}")
    if r.status_code != 200:
        raise SystemExit(f"API error {r.status_code} for {path}:\n{r.text}")
    return r.json()


def delete(session: requests.Session, path: str) -> None:
    session.delete(f"{API}{path}")  # best-effort abandon; ignore result


def fetch(session: requests.Session, package: str) -> dict:
    out = {"package": package}
    edit = post(session, f"/applications/{package}/edits")
    edit_id = edit["id"]
    base = f"/applications/{package}/edits/{edit_id}"
    try:
        # Localized store listings (title, short/full description, video)
        out["listings"] = get(session, f"{base}/listings").get("listings", [])
        # App-level details (default language, contact email/phone/website)
        try:
            out["details"] = get(session, f"{base}/details")
        except SystemExit:
            out["details"] = {}
        # Release tracks (production / beta / alpha / internal) + releases
        try:
            out["tracks"] = get(session, f"{base}/tracks").get("tracks", [])
        except SystemExit:
            out["tracks"] = []
    finally:
        delete(session, base)  # abandon the edit so nothing is committed
    return out


def main() -> None:
    p = argparse.ArgumentParser(
        description="Fetch Google Play store listing + track info via the Developer API."
    )
    p.add_argument("--service-account", required=True, help="Path to the service_account.json key")
    p.add_argument("--package", required=True, help="App package name, e.g. com.example.app")
    p.add_argument("--out", default="play_metadata.json")
    args = p.parse_args()

    token = access_token(args.service_account)
    session = requests.Session()
    session.headers.update({"Authorization": f"Bearer {token}"})

    data = fetch(session, args.package)
    with open(args.out, "w") as f:
        json.dump(data, f, indent=2)
    print(f"Wrote {args.out}")

    listings = data.get("listings", [])
    if listings:
        first = listings[0]
        print(f"Default listing ({first.get('language')}): {first.get('title')}")
    tracks = data.get("tracks", [])
    if tracks:
        names = ", ".join(t.get("track", "?") for t in tracks)
        print(f"Tracks: {names}")


if __name__ == "__main__":
    main()
