/* ================================================================
   kernels.js — the two things a live code cell can run
   ----------------------------------------------------------------
   A cell is only interesting if it actually executes, keeps what it
   computed, and shows a DataFrame as a table rather than as the word
   "DataFrame". That is what these two kernels are for.

   Both run entirely in the browser. Nothing is posted to the server
   and nothing is stored: the code in a cell is the user's own, run on
   the user's own machine, which is the same trust boundary as the
   browser console. That choice also means no sandbox to escape and no
   execution endpoint to secure.

     PyKernel   Real CPython, via Pyodide, fetched from a CDN the first
                time a Python cell is run — about 10 MB, so it is
                deliberately lazy and reports its progress instead of
                appearing to hang. Globals live for the life of the
                page, so cell 2 sees what cell 1 defined, and pip
                installs work through micropip.

     JsKernel   Plain JavaScript with a persistent scope, an awaited
                body, and console output routed into the cell.

   Both return the same shape, so the cell UI never branches on
   language:

     { outputs: [{ kind, value }], error, ms }

   `kind` is one of: 'out' (stdout), 'err' (stderr), 'result' (the
   value of the last expression), 'html', 'image', 'error'.
   ================================================================ */

(function (global) {
  'use strict';

  const PYODIDE_VERSION = '0.26.4';
  const PYODIDE_INDEX = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;

  /* ================================================================
     Python — Pyodide
     ================================================================ */

  const PyKernel = {
    /** 'idle' | 'loading' | 'ready' | 'failed' */
    status: 'idle',
    detail: '',
    py: null,
    _loading: null,
    _watchers: new Set(),

    onStatus(fn) {
      this._watchers.add(fn);
      return () => this._watchers.delete(fn);
    },

    _set(status, detail = '') {
      this.status = status;
      this.detail = detail;
      for (const fn of this._watchers) {
        try { fn(status, detail); } catch (err) { console.error('[kernel]', err); }
      }
    },

    /**
     * Fetch and start Pyodide. Safe to call any number of times — the
     * first call owns the download and every later one waits on it.
     */
    load() {
      if (this._loading) return this._loading;

      this._loading = (async () => {
        this._set('loading', 'Downloading Python (about 10 MB, once per session)…');
        try {
          if (!global.loadPyodide) {
            await new Promise((resolve, reject) => {
              const s = document.createElement('script');
              s.src = PYODIDE_INDEX + 'pyodide.js';
              s.onload = resolve;
              s.onerror = () => reject(new Error(
                'Could not download Pyodide. Python cells need internet access the first time they run.'));
              document.head.appendChild(s);
            });
          }

          this._set('loading', 'Starting the Python interpreter…');
          this.py = await global.loadPyodide({ indexURL: PYODIDE_INDEX });

          // Formatting helpers, defined once. `_repr_html_` is the hook
          // pandas, polars and most scientific libraries expose, so a
          // DataFrame renders as a real table for free.
          this.py.runPython(`
import sys as _sys

def __wb_format(v):
    if v is None:
        return None
    html = getattr(v, "_repr_html_", None)
    if callable(html):
        try:
            return ("html", html())
        except Exception:
            pass
    try:
        return ("text", repr(v))
    except Exception as e:
        return ("text", "<unprintable: %s>" % e)

def __wb_figures():
    """Any matplotlib figures the cell left open, as base64 PNGs."""
    if "matplotlib" not in _sys.modules:
        return []
    try:
        import io, base64
        import matplotlib.pyplot as plt
    except Exception:
        return []
    out = []
    for num in plt.get_fignums():
        try:
            buf = io.BytesIO()
            plt.figure(num).savefig(buf, format="png", bbox_inches="tight", dpi=110)
            out.append(base64.b64encode(buf.getvalue()).decode())
        except Exception:
            pass
    plt.close("all")
    return out
`);

          this._set('ready', 'Python ' + (this.py.version || '3'));
          return this.py;
        } catch (err) {
          this._set('failed', err.message || String(err));
          this._loading = null;          // let the next run retry
          throw err;
        }
      })();

      return this._loading;
    },

    /**
     * `%pip install x y` lines, pulled out and run through micropip before
     * the rest of the cell. Jupyter's own magic, and the only way to get a
     * third-party package into a browser interpreter.
     */
    async _handleMagics(code, emit) {
      const lines = code.split('\n');
      const kept = [];
      const packages = [];

      for (const line of lines) {
        const m = /^\s*[%!]pip\s+install\s+(.+?)\s*$/.exec(line);
        if (m) packages.push(...m[1].split(/\s+/).filter(Boolean));
        else kept.push(line);
      }
      if (!packages.length) return kept.join('\n');

      emit('out', `Installing ${packages.join(', ')}…\n`);
      await this.py.loadPackage('micropip');
      const micropip = this.py.pyimport('micropip');
      try {
        await micropip.install(packages);
        emit('out', `Installed ${packages.join(', ')}.\n`);
      } finally {
        micropip.destroy?.();
      }
      return kept.join('\n');
    },

    async run(code) {
      const outputs = [];
      const started = performance.now();
      const emit = (kind, value) => { if (value !== '' && value != null) outputs.push({ kind, value }); };

      try {
        await this.load();
      } catch (err) {
        return { outputs: [{ kind: 'error', value: err.message }], error: err.message, ms: 0 };
      }

      const py = this.py;
      py.setStdout({ batched: s => emit('out', s) });
      py.setStderr({ batched: s => emit('err', s) });

      let error = null;
      try {
        const body = await this._handleMagics(code, emit);

        // Anything the cell imports that Pyodide ships (numpy, pandas,
        // matplotlib …) is fetched automatically, so `import pandas` in a
        // fresh session just works instead of raising ImportError.
        await py.loadPackagesFromImports(body);

        const value = await py.runPythonAsync(body);

        if (value !== undefined && value !== null) {
          const fmt = py.globals.get('__wb_format');
          try {
            const pair = fmt(value);
            const [kind, text] = pair?.toJs ? pair.toJs() : [];
            if (kind === 'html') emit('html', text);
            else if (text) emit('result', text);
            pair?.destroy?.();
          } finally {
            fmt?.destroy?.();
          }
        }
        value?.destroy?.();

        const figs = py.globals.get('__wb_figures')();
        const list = figs?.toJs ? figs.toJs() : [];
        for (const b64 of list) emit('image', 'data:image/png;base64,' + b64);
        figs?.destroy?.();
      } catch (err) {
        // Pyodide puts the full Python traceback in `message`. That is what
        // the user needs — the JS stack above it is noise.
        error = String(err.message || err).trim();
        emit('error', error);
      } finally {
        py.setStdout({});
        py.setStderr({});
      }

      return { outputs, error, ms: Math.round(performance.now() - started) };
    },

    /** Throw the interpreter away — a fresh kernel, as "Restart" means. */
    reset() {
      this.py = null;
      this._loading = null;
      this._set('idle', '');
    },
  };

  /* ================================================================
     JavaScript
     ================================================================ */

  const JsKernel = {
    status: 'ready',
    _vars: Object.create(null),

    /**
     * A scope that persists between runs.
     *
     * `has` returning true for every name routes all identifier lookups
     * inside `with (scope)` through this proxy, so an undeclared
     * assignment (`total = 5`) lands here and is still there in the next
     * cell. Names it does not hold fall through to the real global, so
     * `Math`, `fetch` and `document` behave normally.
     *
     * `let` and `const` remain block-scoped to the run that declared
     * them — that is the language, not a limitation of this shim — which
     * is why the cell's placeholder uses plain assignment.
     */
    _scope(ctx) {
      const store = this._vars;
      return new Proxy(store, {
        has: () => true,
        get: (t, k) => {
          if (k === Symbol.unscopables) return undefined;
          if (k in t) return t[k];
          // The cell's own API — console, display, board — resolves before
          // the real global. `has` returning true routes EVERY name through
          // this proxy, so a second `with (ctx)` around it would be
          // shadowed: output went to the browser console instead of into
          // the cell, and the cell showed nothing.
          if (ctx && k in ctx) return ctx[k];
          return global[k];
        },
        set: (t, k, v) => { t[k] = v; return true; },
        deleteProperty: (t, k) => { delete t[k]; return true; },
      });
    },

    /**
     * Make the last expression the cell's result, the way a notebook does.
     *
     * The body runs inside an async function, and an async function does
     * not hand back the completion value of its last statement — so
     * `values.map(Math.sqrt)` on the final line computed the array and
     * silently threw it away. Adding an explicit `return` is what turns it
     * back into a result.
     *
     * The transform is deliberately timid: anything that is plainly not a
     * standalone expression is left alone, and if the rewrite does not
     * compile the original source is used instead. A cell that shows no
     * result is a small loss; a cell that refuses to run is not.
     */
    _withResult(code) {
      const lines = code.split('\n');
      let i = lines.length - 1;
      while (i >= 0 && (!lines[i].trim() || lines[i].trim().startsWith('//'))) i--;
      if (i < 0) return code;

      const raw = lines[i];
      const last = raw.trim();
      if (/^(return|const|let|var|function|class|async|if|else|for|while|do|switch|case|default|try|catch|finally|throw|break|continue|import|export|debugger)\b/.test(last)) return code;
      if (/^[)\]},.:?]/.test(last) || /[{,([]$/.test(last) || last.endsWith('=>')) return code;

      const rewritten = [...lines];
      rewritten[i] = `${raw.match(/^\s*/)[0]}return (${last.replace(/;+$/, '')});`;
      return rewritten.join('\n');
    },

    _compile(body) {
      // eslint-disable-next-line no-new-func
      return new Function('__scope', `
        return (async function () {
          with (__scope) {
${body}
          }
        })();
      `);
    },

    async run(code, api = {}) {
      const outputs = [];
      const started = performance.now();
      const emit = (kind, value) => outputs.push({ kind, value });

      const fmt = v => {
        if (typeof v === 'string') return v;
        if (v instanceof Error) return v.stack || String(v);
        if (v instanceof Element) return v.outerHTML;
        try { return JSON.stringify(v, replacer(), 2); }
        catch { return String(v); }
      };
      const line = args => args.map(fmt).join(' ') + '\n';

      const shim = {
        log:   (...a) => emit('out', line(a)),
        info:  (...a) => emit('out', line(a)),
        debug: (...a) => emit('out', line(a)),
        warn:  (...a) => emit('err', line(a)),
        error: (...a) => emit('err', line(a)),
        table: (...a) => emit('out', line(a)),
        dir:   (...a) => emit('out', line(a)),
      };

      const ctx = {
        console: shim,
        /** Put anything on screen: HTML string, DOM node, image URL, value. */
        display: v => {
          if (v instanceof Element) emit('html', v.outerHTML);
          else if (typeof v === 'string' && /^(data:image\/|https?:\/\/\S+\.(png|jpe?g|gif|svg|webp))/i.test(v)) emit('image', v);
          else if (typeof v === 'string' && /^\s*</.test(v)) emit('html', v);
          else emit('result', fmt(v));
        },
        ...api,
      };

      let error = null;
      try {
        // Sloppy mode on purpose: `with` is what makes the persistent
        // scope above work, and a Function body is sloppy unless it opts
        // in. The cell's own code can still declare "use strict".
        let runner;
        try {
          runner = this._compile(this._withResult(code));
        } catch (rewriteErr) {
          // The last-expression rewrite did not parse. Run what was
          // written; only the displayed result is lost.
          runner = this._compile(code);
        }
        const value = await runner(this._scope(ctx));
        if (value !== undefined) emit('result', fmt(value));
      } catch (err) {
        error = err?.stack || String(err);
        emit('error', error);
      }

      return { outputs, error, ms: Math.round(performance.now() - started) };
    },

    reset() { this._vars = Object.create(null); },
  };

  /** JSON.stringify that survives cycles, functions and DOM nodes. */
  function replacer() {
    const seen = new WeakSet();
    return function (key, value) {
      if (typeof value === 'function') return `[Function ${value.name || 'anonymous'}]`;
      if (typeof value === 'bigint') return value.toString() + 'n';
      if (value instanceof Element) return `[${value.tagName.toLowerCase()}]`;
      if (value && typeof value === 'object') {
        if (seen.has(value)) return '[Circular]';
        seen.add(value);
      }
      return value;
    };
  }

  global.WBKernels = { PyKernel, JsKernel };
})(window);
