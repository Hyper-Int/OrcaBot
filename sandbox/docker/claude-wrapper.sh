#!/bin/bash
printf "\n"
sleep 1
printf "Installing Claude Code from npm...\n"
printf "By continuing, you agree to Anthropic's Terms of Service.\n"
sleep 1
for i in 3 2 1; do printf "\Installing in %d..." "$i"; sleep 1; done
printf "\r                \n"
rm -f /usr/local/bin/claude
npm install -g @anthropic-ai/claude-code && exec claude "$@"
