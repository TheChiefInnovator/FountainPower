#!/usr/bin/env python3
import argparse
import fcntl
import json
import os
import re
import select
import termios
import time


def configure_serial(fd):
    attrs = termios.tcgetattr(fd)
    attrs[0] = 0
    attrs[1] = 0
    attrs[2] = termios.CREAD | termios.CLOCAL | termios.CS8
    attrs[3] = 0
    attrs[4] = termios.B9600
    attrs[5] = termios.B9600
    attrs[6][termios.VMIN] = 0
    attrs[6][termios.VTIME] = 0
    termios.tcsetattr(fd, termios.TCSANOW, attrs)
    termios.tcflush(fd, termios.TCIOFLUSH)


def read_available(fd, seconds):
    end = time.time() + seconds
    chunks = []

    while time.time() < end:
        readable, _, _ = select.select([fd], [], [], 0.15)
        if not readable:
            continue
        chunk = os.read(fd, 4096)
        if not chunk:
            continue
        chunks.append(chunk)

    return b"".join(chunks).decode("utf-8", errors="replace")


def run_command(device, command, password=None):
    lock = open(os.environ.get("POWER_SERIAL_LOCK", "/tmp/fountain-power-serial.lock"), "a")
    fcntl.flock(lock, fcntl.LOCK_EX)
    fd = os.open(device, os.O_RDWR | os.O_NOCTTY | os.O_NONBLOCK)

    try:
        configure_serial(fd)
        greeting = read_available(fd, 0.6)

        if not greeting:
            os.write(fd, b"\r")
            time.sleep(0.25)
            greeting = read_available(fd, 0.5)

        if password and "password" in greeting.lower():
            os.write(fd, password.encode("ascii") + b"\r")
            time.sleep(0.35)
            read_available(fd, 0.8)

        os.write(fd, command.encode("ascii") + b"\r")
        return read_available(fd, 2.5)
    finally:
        os.close(fd)
        lock.close()


def parse_states(raw):
    states = {}

    for line in raw.splitlines():
        upper = line.upper()
        columns = [column.strip() for column in upper.split("|")]

        if len(columns) >= 4 and re.match(r"^[1-8]$", columns[0]) and columns[3] in ("ON", "OFF"):
            states[columns[0]] = columns[3].lower()
            continue

    return states


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--device", default="/dev/cu.usbserial-FTEPND0D")
    parser.add_argument("--password", default=os.environ.get("POWER_SERIAL_PASSWORD"))
    parser.add_argument("action", choices=["status", "on", "off", "boot"])
    parser.add_argument("outlet", nargs="?")
    args = parser.parse_args()

    if args.action == "status":
        raw = run_command(args.device, "/S", args.password)
        print(json.dumps({"states": parse_states(raw), "raw": raw}))
        return

    if not args.outlet or not re.match(r"^[1-8]$", args.outlet):
        raise SystemExit("Outlet must be a number from 1 to 8.")

    command = {
        "on": "/On",
        "off": "/Off",
        "boot": "/Boot",
    }[args.action]
    raw = run_command(args.device, f"{command} {args.outlet},y", args.password)
    print(json.dumps({"state": args.action, "raw": raw}))


if __name__ == "__main__":
    main()
