import json
import os
import time
import xml.etree.ElementTree as ET
from pathlib import Path

import requests
from dotenv import load_dotenv

API_URL = "https://www.nationstates.net/cgi-bin/api.cgi"
STATE_FILE = Path("state.json")

load_dotenv()

CLIENT_KEY = os.getenv("NS_CLIENT_KEY", "").strip()

NEW_NATIONS_TGID = os.getenv("NEW_NATIONS_TGID", "").strip()
NEW_NATIONS_SECRET = os.getenv("NEW_NATIONS_SECRET", "").strip()

NEW_WA_TGID = os.getenv("NEW_WA_TGID", "").strip()
NEW_WA_SECRET = os.getenv("NEW_WA_SECRET", "").strip()

USER_AGENT = os.getenv(
    "USER_AGENT",
    "NationStates AutoTelegram/1.0 (contact: replace-me@example.com)"
).strip()

POLL_SECONDS = max(60, int(os.getenv("POLL_SECONDS", "180")))

# Recruitment TGs must be spaced by at least 180 seconds.
TG_DELAY = 180

session = requests.Session()
session.headers.update({
    "User-Agent": USER_AGENT,
    "Accept": "application/xml,text/xml;q=0.9,*/*;q=0.8",
})


def check_settings():
    missing = []

    if not CLIENT_KEY:
        missing.append("NS_CLIENT_KEY")

    if not NEW_NATIONS_TGID or not NEW_NATIONS_SECRET:
        missing.append("NEW_NATIONS_TGID / NEW_NATIONS_SECRET")

    if not NEW_WA_TGID or not NEW_WA_SECRET:
        missing.append("NEW_WA_TGID / NEW_WA_SECRET")

    if not USER_AGENT or "replace-me@example.com" in USER_AGENT:
        missing.append("USER_AGENT")

    if missing:
        print("Missing settings:")
        for item in missing:
            print("-", item)
        raise SystemExit


def load_state():
    if not STATE_FILE.exists():
        return {
            "initialized": False,
            "seen_new_nations": [],
            "seen_wa_members": [],
            "queue": [],
            "last_tg": 0
        }

    try:
        return json.loads(
            STATE_FILE.read_text(encoding="utf-8")
        )
    except Exception:
        return {
            "initialized": False,
            "seen_new_nations": [],
            "seen_wa_members": [],
            "queue": [],
            "last_tg": 0
        }


def save_state(state):
    STATE_FILE.write_text(
        json.dumps(state, indent=2),
        encoding="utf-8"
    )


def api_request(params):
    response = session.get(
        API_URL,
        params=params,
        timeout=45
    )

    if response.status_code == 429:
        raise RuntimeError("NationStates API rate limit reached.")

    response.raise_for_status()

    return ET.fromstring(response.content)


def get_new_nations():
    root = api_request({
        "q": "newnations"
    })

    nations = []

    for element in root.iter():
        if element.tag.upper() == "NATION":
            name = (
                element.text
                or element.attrib.get("name", "")
            ).strip()

            if name:
                nations.append(name.lower())

    return list(dict.fromkeys(nations))


def get_wa_members():
    root = api_request({
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
            ).strip()

            if name:
                members.add(name.lower())

    return members


def add_to_queue(state, nation, target_type):
    nation = nation.lower().strip()

    for item in state["queue"]:
        if (
            item["nation"] == nation
            and item["type"] == target_type
        ):
            return

    state["queue"].append({
        "nation": nation,
        "type": target_type
    })


def scan(state):
    print("Checking NationStates...")

    new_nations = get_new_nations()
    wa_members = get_wa_members()

    old_new_nations = set(
        state["seen_new_nations"]
    )

    old_wa_members = set(
        state["seen_wa_members"]
    )

    # First run: record existing nations instead of
    # immediately messaging all of them.
    if not state["initialized"]:

        state["seen_new_nations"] = list(
            new_nations
        )

        state["seen_wa_members"] = list(
            wa_members
        )

        state["initialized"] = True

        save_state(state)

        print("First scan complete.")
        print("Existing targets were recorded.")
        return

    # Newly founded nations
    for nation in new_nations:

        if nation not in old_new_nations:
            add_to_queue(
                state,
                nation,
                "new_nation"
            )

    # Newly detected WA members
    for nation in wa_members:

        if nation not in old_wa_members:
            add_to_queue(
                state,
                nation,
                "new_wa"
            )

    state["seen_new_nations"] = list(
        new_nations
    )

    state["seen_wa_members"] = list(
        wa_members
    )

    save_state(state)

    print(
        "Queue:",
        len(state["queue"])
    )


def send_telegram(item):
    nation = item["nation"]
    target_type = item["type"]

    if target_type == "new_nation":

        tgid = NEW_NATIONS_TGID
        secret = NEW_NATIONS_SECRET

    else:

        tgid = NEW_WA_TGID
        secret = NEW_WA_SECRET

    params = {
        "a": "sendTG",
        "client": CLIENT_KEY,
        "tgid": tgid,
        "key": secret,
        "to": nation
    }

    response = session.get(
        API_URL,
        params=params,
        timeout=45
    )

    if response.status_code == 429:
        print("Telegram rate limit reached.")
        return False

    if response.status_code >= 400:
        print(
            "Telegram failed:",
            nation,
            response.status_code
        )
        return False

    print(
        "Telegram sent to:",
        nation
    )

    return True


def process_queue(state):

    if not state["queue"]:
        return

    elapsed = (
        time.time()
        - float(state.get("last_tg", 0))
    )

    if elapsed < TG_DELAY:

        remaining = int(
            TG_DELAY - elapsed
        )

        print(
            "Waiting",
            remaining,
            "seconds before next TG."
        )

        return

    item = state["queue"][0]

    if send_telegram(item):

        state["queue"].pop(0)

        state["last_tg"] = time.time()

        save_state(state)


def main():

    check_settings()

    print("--------------------------------")
    print("NationStates AutoTelegram")
    print("--------------------------------")
    print("Recruitment TG delay:", TG_DELAY)
    print("Polling every:", POLL_SECONDS)
    print()

    state = load_state()

    while True:

        try:

            scan(state)

            process_queue(state)

            save_state(state)

        except KeyboardInterrupt:

            print("Bot stopped.")
            break

        except Exception as error:

            print(
                "ERROR:",
                error
            )

        print(
            "Sleeping",
            POLL_SECONDS,
            "seconds..."
        )

        time.sleep(POLL_SECONDS)


if __name__ == "__main__":
    main()
