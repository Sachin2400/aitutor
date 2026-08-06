AI Teleprompter — run locally
=============================

IMPORTANT: the microphone only works over http:// (not file://).

1) Unzip this folder.
2) Open a terminal in the folder and run:
       python -m http.server 8000
   (Windows: py -m http.server 8000)
3) Open Google Chrome at:  http://localhost:8000
4) Click "Settings", paste your Gemini key and/or Groq key
   (each has its own box), pick the active provider, click Save.
   You should see "Saved — Gemini ✓ · Groq ✓".
5) Click "Start Listening" and allow microphone access.

Keys are saved in your browser's localStorage, separately per provider.
Get keys: Gemini -> aistudio.google.com/apikey , Groq -> console.groq.com/keys
