# pi-grok-build

Use Grok in Pi with the login you already have from the official `grok` CLI.

No xAI API key. No separate console billing. If `grok` works in your terminal, this extension lets Pi use the same session.

## What this is

A small Pi extension that registers a provider called `grok-cli`.

It reads your Grok CLI token from:

```txt
~/.grok/auth.json
```

and sends Pi requests to Grok's CLI chat proxy:

```txt
https://cli-chat-proxy.grok.com/v1
```

## Requirements

Install Pi and Grok CLI first.

Then log in with Grok:

```bash
grok login
```

Check that Grok itself works:

```bash
grok -p "say hi"
```

If that fails, fix Grok before trying this extension.

## Install

From this repo:

```bash
pi install git:github.com/IgorWarzocha/pi-grok-build
```

Then run:

```bash
pi --provider grok-cli --model grok-4.5
```

## Run from a local checkout

```bash
pi -e /home/igorw/Work/pi-grok/src/index.ts --provider grok-cli --model grok-4.5
```

Or use Composer:

```bash
pi -e /home/igorw/Work/pi-grok/src/index.ts --provider grok-cli --model grok-composer-2.5-fast
```

## Models

| Model | Notes |
| --- | --- |
| `grok-4.5` | Current Grok CLI model. Large context. Supports `low`, `medium`, and `high` thinking. |
| `grok-composer-2.5-fast` | Fast Composer model. |

These come from Grok's local model cache, not from `api.x.ai`.

## Login inside Pi

If Pi asks for auth:

```txt
/login grok-cli
```

The extension does not open its own subscription flow first. It reuses `grok login`.

## How it works

The proxy needs a few Grok-specific headers:

```txt
X-XAI-Token-Auth: xai-grok-cli
x-grok-client-version: <your local grok CLI version>
x-grok-model-override: <model>
```

The model override matters. The proxy routes by header, not just by the JSON body.

## Troubleshooting

### `No Grok login found`

Run:

```bash
grok login
```

### `Grok CLI version is outdated`

Update Grok:

```bash
grok update
```

The extension reads the client version from `~/.grok/version.json` and falls back to `0.2.91` if that file is missing.

### Grok starts returning 401 after running for a while

The extension refreshes expired Grok credentials automatically. If refresh fails because the CLI session itself is no longer valid, run `grok login` again.

### Pi cannot find the provider

Make sure the extension is installed, or pass it explicitly:

```bash
pi -e /absolute/path/to/pi-grok-build/src/index.ts --provider grok-cli --model grok-4.5
```

## Notes

This is not the same as xAI's public API at `https://api.x.ai/v1`.

It is also not the old X Premium+ / SuperGrok OAuth experiment. This follows the working Grok Build CLI path.
