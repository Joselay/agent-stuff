# Running Scripts with uv

For a dependency-free script:

```bash
uv run script.py
uv run --python 3.12 script.py
uv run --no-project script.py  # Isolate it from the surrounding project
```

## Ad-hoc Dependencies

```bash
uv run --with requests script.py
uv run --with 'requests>2,<3' script.py
uv run --with requests --with rich script.py
```

## Inline Metadata

For a maintained standalone script, declare every dependency and the Python requirement using PEP 723 metadata:

```python
# /// script
# requires-python = ">=3.12"
# dependencies = [
#   "requests<3",
#   "rich",
# ]
# ///

import requests
from rich import print
```

```bash
uv init --script example.py --python 3.12
uv add --script example.py requests rich
uv run example.py
```

Inline metadata isolates the script from any surrounding project. Keep `dependencies = []` even when empty.

### Alternative indexes

```bash
uv add --index "https://example.com/simple" --script example.py requests
```

Adds to metadata:

```python
# [[tool.uv.index]]
# url = "https://example.com/simple"
```

## Reproducibility

```bash
uv lock --script example.py  # Creates example.py.lock beside the script
```

For time-bounded resolution:

```python
# /// script
# dependencies = ["requests"]
# [tool.uv]
# exclude-newer = "2023-10-16T00:00:00Z"
# ///
```

## Executable scripts

```python
#!/usr/bin/env -S uv run --script
# /// script
# dependencies = ["httpx"]
# ///

import httpx
print(httpx.get("https://example.com"))
```

```bash
chmod +x myscript
./myscript
```
