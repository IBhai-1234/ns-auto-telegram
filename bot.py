import json
import os
import time
import xml.etree.ElementTree as ET
from pathlib import Path

import requests

API = "https://www.nationstates.net/cgi-bin/api.cgi"
STATE_FILE = Path("state.json")

CLIENT_KEY = os.environ["NS_CLIENT_KEY"]
TGID = os.environ["TGID"]
SECRET_KEY = os.environ["SECRET_KEY"]
USER_AGENT = os.environ["USER_AGENT"]

# Never send recruitment telegrams faster than this.
SEND_DELAY = 180

# GitHub Actions should not run forever.
# This leaves time for the workflow to finish cleanly.
MAX_RUNTIME = 1650  # 27.5 minutes

session = requests.Session()
session.headers.update({
    "User-Agent": USER_AGENT
})


def api_get(params):
    response = session.get(
        API,
        params=params,
        timeout=45
    )

    response.raise_for_status()

    return ET.fromstring(response.content)


def get_new_nations():
    root = api_get({
        "q": "newnations"
    })

    nations = []

    for element in root.iter():
        if element.tag.upper() == "NATION":
            name = (
                element.text
                or element.attrib.get("name", "")
            ).strip().lower()

            if name:
                nations.append(name)

    return list(dict.fromkeys(nations))


def get_wa_members():
    # WA=1 remains the legacy GA membership endpoint.
    root = api_get({
        "wa": "1",
        "q": "members"
    })

    members = set()

    for element in root.iter():
        if element.tag.upper() in ("NATION", "MEMBER"):
            name = (
                element.text
                or element.attrib.get("name", "")
                or element.attrib.get("nation", "")
            ).strip().lower()

            if name:
                members.add(name)

    return members


def load_state():

    if not STATE_FILE.exists():
        return {
            "initialized": False,
            "seen_new": [],
            "seen_wa": [],
            "queue": [],
            "last_send": 0
        }

    try:
        return json.loads(
            STATE_FILE.read_text(
                encoding="utf-8"
            )
        )
    except Exception:
        return {
            "initialized": False,
            "seen_new": [],
            "seen_wa": [],
            "queue": [],
            "last_send": 0
        }


def save_state(state):

    STATE_FILE.write_text(
        json.dumps(
            state,
            indent=2,
            sort_keys=True
        ),
        encoding="utf-8"
    )


def add_target(state, nation, target_type):

    nation = nation.lower().strip()

    for item in state["queue"]:
        if item["nation"] == nation:
            return

    state["queue"].append({
        "nation": nation,
        "type": target_type
    })


def discover(state):

    print("Getting new nations...")

    new_nations = get_new_nations()

    print(
        "New-nation list:",
        len(new_nations)
    )

    print("Getting WA members...")

    wa_members = get_wa_members()

    print(
        "WA members:",
        len(wa_members)
    )

    old_new = set(state["seen_new"])
    old_wa = set(state["seen_wa"])

    # First run only records the existing lists.
    # This prevents accidentally messaging every nation
    # already present when the bot is first installed.
    if not state["initialized"]:

        state["seen_new"] = new_nations
        state["seen_wa"] = list(wa_members)
        state["initialized"] = True

        print(
            "Initial scan recorded. "
            "Existing nations were not queued."
        )

        return

    # Newly appearing nations
    for nation in new_nations:

        if nation not in old_new:
            add_target(
                state,
                nation,
                "new_nation"
            )

    # Newly appearing WA members
    for nation in wa_members:

        if nation not in old_wa:
            add_target(
                state,
                nation,
                "new_wa"
            )

    state["seen_new"] = new_nations
    state["seen_wa"] = list(wa_members)


def send_telegram(nation):

    response = session.get(
        API,
        params={
            "a": "sendTG",
            "client": CLIENT_KEY,
            "tgid": TGID,
            "key": SECRET_KEY,
            "to": nation
        },
        timeout=45
    )

    if response.status_code == 429:
        print(
            "NationStates rate limit reached."
        )
        return False

    if response.status_code >= 400:
        print(
            "Telegram failed:",
            nation,
            response.status_code
        )
        return False

    print(
        "Telegram sent:",
        nation
    )

    return True


def process_queue(state, start_time):

    while state["queue"]:

        # Do not allow this Actions job to run forever.
        if time.time() - start_time >= MAX_RUNTIME:
            print(
                "Maximum workflow runtime reached."
            )
            break

        elapsed = (
            time.time()
            - float(state["last_send"])
        )

        wait = SEND_DELAY - elapsed

        if wait > 0:

            print(
                "Waiting",
                int(wait),
                "seconds..."
            )

            time.sleep(wait)

        item = state["queue"][0]

        if send_telegram(item["nation"]):

            state["queue"].pop(0)
            state["last_send"] = time.time()

            save_state(state)

        else:
            print(
                "Send failed. "
                "Keeping target in queue."
            )
            break


def main():

    started = time.time()

    state = load_state()

    discover(state)

    save_state(state)

    print(
        "Queue:",
        len(state["queue"])
    )

    process_queue(
        state,
        started
    )

    save_state(state)

    print(
        "Finished. Remaining queue:",
        len(state["queue"])
    )


if __name__ == "__main__":
    main()
