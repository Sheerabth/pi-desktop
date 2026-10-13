#!/bin/sh
# Browser mode: web backend (pi RPC bridge) + vite, same ports every time.
# Frontend proxies /api -> backend, so the app just works at the vite URL.
PORT=1423 node server/web-backend.mjs &
BACK=$!
trap "kill $BACK 2>/dev/null" EXIT INT TERM
vite --port 1422 --strictPort
