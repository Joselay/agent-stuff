# uv Build Backend

Use `uv_build` for pure Python packages. Let `uv init` generate a compatible backend version range:

```bash
uv init --lib <name>       # Library
uv init --package <name>   # Packaged application
```

For an existing project, generate a bare scratch project with the installed `uv` and copy its `[build-system]` table:

```bash
uv init --bare --build-backend uv <scratch-dir>
```

The generated requirement carries a lower bound and next-minor upper bound. Preserve both.

## Layout

Default layout uses `src/<package_name>/__init__.py`:

```
pyproject.toml
src/
└── my_package/
    └── __init__.py
```

Package name is normalized: `Foo-Bar` → `foo_bar`.

### Custom module location

```toml
[tool.uv.build-backend]
module-name = "mymodule"
module-root = ""  # Use project root instead of src/
```

### Namespace packages

For `foo.bar` namespace:

```
src/foo/bar/__init__.py  # No __init__.py in foo/
```

```toml
[tool.uv.build-backend]
module-name = "foo.bar"
```

## File inclusion

Excludes `__pycache__`, `*.pyc`, `*.pyo` by default.

```toml
[tool.uv.build-backend]
source-include = ["assets/**"]
source-exclude = ["/dist", "tests/**"]
```

- Includes are anchored (`pyproject.toml` = only root)
- Excludes are not anchored (`__pycache__` = all dirs named that)
- Use `/prefix` to anchor excludes

For extension modules, select a backend matched to the implementation: `maturin` for Rust or `scikit-build-core` for C, C++, Fortran, or Cython.
