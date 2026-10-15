// Static catalogs used to tell standard-library modules apart from third-party dependencies.

export const NODE_BUILTINS = new Set('assert assert/strict async_hooks buffer child_process cluster console constants crypto dgram diagnostics_channel dns dns/promises domain events fs fs/promises http http2 https inspector inspector/promises module net os path path/posix path/win32 perf_hooks process punycode querystring readline readline/promises repl stream stream/consumers stream/promises stream/web string_decoder sys timers timers/promises tls trace_events tty url util util/types v8 vm wasi worker_threads zlib test sqlite sea'.split(' '));
export const isNodeBuiltin = spec => spec.startsWith('node:') || NODE_BUILTINS.has(spec) || NODE_BUILTINS.has(spec.split('/')[0]);

// CPython standard library (3.8 through 3.14), including modules removed in recent versions so that
// older projects are not told their stdlib imports are undeclared dependencies.
export const PYTHON_STDLIB = new Set(('__future__ __main__ abc aifc annotationlib antigravity argparse array ast asynchat asyncio asyncore atexit audioop base64 bdb binascii bisect builtins bz2 cProfile calendar cgi cgitb chunk cmath cmd code codecs codeop collections colorsys compileall compression concurrent configparser contextlib contextvars copy copyreg crypt csv ctypes curses dataclasses datetime dbm decimal difflib dis distutils doctest email encodings ensurepip enum errno faulthandler fcntl filecmp fileinput fnmatch fractions ftplib functools gc genericpath getopt getpass gettext glob graphlib grp gzip hashlib heapq hmac html http idlelib imaplib imghdr imp importlib inspect io ipaddress itertools json keyword lib2to3 linecache locale logging lzma mailbox mailcap marshal math mimetypes mmap modulefinder msilib msvcrt multiprocessing netrc nis nntplib nt ntpath nturl2path numbers opcode operator optparse os ossaudiodev pathlib pdb pickle pickletools pipes pkgutil platform plistlib poplib posix posixpath pprint profile pstats pty pwd py_compile pyclbr pydoc pydoc_data pyexpat queue quopri random re readline reprlib resource rlcompleter runpy sched secrets select selectors shelve shlex shutil signal site smtpd smtplib sndhdr socket socketserver spwd sqlite3 sre_compile sre_constants sre_parse ssl stat statistics string stringprep struct subprocess sunau symtable sys sysconfig syslog tabnanny tarfile telnetlib tempfile termios textwrap this threading time timeit tkinter token tokenize tomllib trace traceback tracemalloc tty turtle turtledemo types typing unicodedata unittest urllib uu uuid venv warnings wave weakref webbrowser winreg winsound wsgiref xdrlib xml xmlrpc zipapp zipfile zipimport zlib zoneinfo _thread').split(' '));

// Import name -> distribution name, for packages whose names differ.
export const PYTHON_IMPORT_ALIASES = {
  yaml: 'pyyaml', cv2: 'opencv-python', sklearn: 'scikit-learn', skimage: 'scikit-image', PIL: 'pillow', bs4: 'beautifulsoup4',
  dateutil: 'python-dateutil', dotenv: 'python-dotenv', jwt: 'pyjwt', Crypto: 'pycryptodome', OpenSSL: 'pyopenssl', serial: 'pyserial',
  google: 'google-*', attr: 'attrs', magic: 'python-magic', multipart: 'python-multipart', jose: 'python-jose', docx: 'python-docx',
  pptx: 'python-pptx', fitz: 'pymupdf', mpl_toolkits: 'matplotlib', websocket: 'websocket-client', psycopg2: 'psycopg2-binary',
  MySQLdb: 'mysqlclient', telegram: 'python-telegram-bot', discord: 'discord.py', git: 'gitpython', zmq: 'pyzmq', usb: 'pyusb',
  win32api: 'pywin32', win32con: 'pywin32', pkg_resources: 'setuptools', setuptools: 'setuptools', _pytest: 'pytest', typing_extensions: 'typing-extensions',
};

// Tools normally invoked from scripts or config rather than imported; not reported as unused dependencies.
export const TOOLING_PACKAGES = /^(?:@types\/|typescript$|ts-node$|tsx$|eslint|@eslint\/|prettier|@typescript-eslint\/|jest$|vitest$|@vitest\/|mocha$|nyc$|c8$|husky$|lint-staged$|nodemon$|concurrently$|cross-env$|rimraf$|npm-run-all|vite$|@vitejs\/|webpack|rollup|@rollup\/|esbuild$|parcel|babel|@babel\/|postcss|autoprefixer|tailwindcss$|sass$|less$|stylelint|@swc\/|swc$|turbo$|lerna$|nx$|@nx\/|semantic-release|@commitlint|commitizen|standard-version|patch-package|serve$|http-server$|live-server$|wrangler$|vercel$|netlify-cli$|electron-builder|electron$|@storybook\/|storybook$|playwright|@playwright\/|cypress$|puppeteer$|supertest$|chai$|sinon$|@testing-library\/|jsdom$|happy-dom$|msw$|nock$|ts-jest$|@jest\/|jest-|vite-|eslint-|prettier-)/;

export const FRAMEWORKS = [
  ['next', 'Next.js'], ['react', 'React'], ['vue', 'Vue'], ['nuxt', 'Nuxt'], ['svelte', 'Svelte'], ['@angular/core', 'Angular'], ['solid-js', 'Solid'],
  ['express', 'Express'], ['fastify', 'Fastify'], ['koa', 'Koa'], ['@nestjs/core', 'NestJS'], ['hono', 'Hono'], ['electron', 'Electron'],
  ['vite', 'Vite'], ['webpack', 'webpack'], ['jest', 'Jest'], ['vitest', 'Vitest'], ['mocha', 'Mocha'], ['@playwright/test', 'Playwright'],
  ['prisma', 'Prisma'], ['@prisma/client', 'Prisma'], ['mongoose', 'Mongoose'], ['sequelize', 'Sequelize'], ['typeorm', 'TypeORM'],
];
export const PY_FRAMEWORKS = [['django', 'Django'], ['flask', 'Flask'], ['fastapi', 'FastAPI'], ['pytest', 'pytest'], ['numpy', 'NumPy'], ['pandas', 'pandas'], ['torch', 'PyTorch'], ['sqlalchemy', 'SQLAlchemy']];
