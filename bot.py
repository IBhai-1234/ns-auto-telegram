import json
import os
import time
import xml.etree.ElementTree as ET
from pathlib import Path

import requests

API = "https://www.nationstates.net/cgi-bin/api.cgi"
STATE = Path("state.json")

CLIENT = os.environ["NS_CLIENT_KEY"]
NEW_TGID = os.environ["NEW_NATIONS_TGID"]
NEW_SECRET = os.environ["NEW_NATIONS_SECRET"]
WA_TGID = os.environ["NEW_WA_TGID"]
WA_SECRET = os.environ["NEW_WA_SECRET"]
USER_AGENT = os.environ["USER_AGENT"]

HEADERS = {
    "User-Agent": USER_AGENT
}


def api(params):
    r = requests.get(
        API,
        params=params,
        headers=HEADERS,
        timeout=45
    )

    r.raise_for_status()
    return ET.fromstring(r.content)


def new_nations():
    root = api({"q": "newnations"})

    result = []

    for x in root.iter():
        if x.tag.upper() == "NATION":
            name = (
                x.text
                or x.attrib.get("name", "")
            ).strip().lower()

            if name:
                result.append(name)

    return list(dict.fromkeys(result))


def wa_members():
    root = api({
        "wa": "1",
        "q": "members"
    })

    result = set()

    for x in root.iter():
        if x.tag.upper() in ("NATION", "MEMBER"):
            name = (
                x.text
                or x.attrib.get("name", "")
                or x.attrib.get("nation", "")
            ).strip().lower()

            if name:
                result.add(name)

    return result


def load():
    if not STATE.exists():
        return {
            "new_seen": [],
            "wa_seen": [],
            "queue": [],
            "last_send": 0
        }

    try:
        return json.loads(
            STATE.read_text()
        )
    except Exception:
        return {
            "new_seen": [],
            "wa_seen": [],
            "queue": [],
            "last_send": 0
        }


def save(s):
    STATE.write_text(
        json.dumps(s, indent=2)
    )


def queue(s, nation, kind):

    for item in s["queue"]:
        if (
            item["nation"] == nation
            and item["kind"] == kind
        ):
            return

    s["queue"].append({
        "nation": nation,
        "kind": kind
    })


def send(nation, kind):

    if kind == "new":
        tgid = NEW_TGID
        secret = NEW_SECRET
    else:
        tgid = WA_TGID
        secret = WA_SECRET

    r = requests.get(
        API,
        params={
            "a": "sendTG",
            "client": CLIENT,
            "tgid": tgid,
            "key": secret,
            "to": nation
        },
        headers=HEADERS,
        timeout=45
    )

    if r.status_code == 429:
        print("NationStates rate limit.")
        return False

    if r.status_code >= 400:
        print(
            "TG failed:",
            nation,
            r.status_code
        )
        return False

    print(
        "TG sent:",
        nation,
        kind
    )

    return True


def main():

    s = load()

    print("Getting new nations...")
    nations = new_nations()

    print(
        "Found",
        len(nations),
        "new-nation entries."
    )

    print("Getting WA members...")
    members = wa_members()

    old_new = set(s["new_seen"])
    old_wa = set(s["wa_seen"])

    # New nations
    for nation in nations:
        if nation not in old_new:
            queue(
                s,
                nation,
                "new"
            )

    # Newly detected WA members
    for nation in members - old_wa:
        queue(
            s,
            nation,
            "wa"
        )

    s["new_seen"] = nations
    s["wa_seen"] = list(members)

    # Recruitment TG rate limit:
    # do not send again until 180 seconds have passed.
    now = time.time()

    if s["queue"]:
        if now - s["last_send"] >= 180:

            item = s["queue"][0]

            if send(
                item["nation"],
                item["kind"]
            ):
                s["queue"].pop(0)
                s["last_send"] = time.time()

    print(
        "Remaining queue:",
        len(s["queue"])
    )

    save(s)


if __name__ == "__main__":
    main()
