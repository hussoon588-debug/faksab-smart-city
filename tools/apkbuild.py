#!/usr/bin/env python3
"""Build a signed, installable APK for FAKSAB Smart City without aapt/aapt2.

Pipeline: hand-encoded binary AndroidManifest.xml + resources.arsc, javac,
d8, a hand-written zip, apksigner.
"""
import os, struct, zlib, subprocess, pathlib, sys, shutil

ROOT = pathlib.Path(__file__).resolve().parent.parent
SDK = pathlib.Path('/tmp/superlisa/sdk')
JDK = SDK / 'jdk-17.0.21+9/bin'
ANDROID_JAR = SDK / 'android-34/android.jar'
D8 = SDK / 'android-14/lib/d8.jar'
APKSIGNER = SDK / 'android-14/lib/apksigner.jar'

BUILD = ROOT / 'build'
ANDROID_NS = 'http://schemas.android.com/apk/res/android'

# android attribute resource ids, read from the framework resources.arsc
ATTR_ID = {
    'versionCode': 0x0101021b, 'versionName': 0x0101021c,
    'minSdkVersion': 0x0101020c, 'targetSdkVersion': 0x01010270,
    'label': 0x01010001, 'icon': 0x01010002, 'roundIcon': 0x0101052c,
    'name': 0x01010003, 'exported': 0x01010010, 'allowBackup': 0x01010280,
    'supportsRtl': 0x010103af, 'hardwareAccelerated': 0x010102d3,
    'usesCleartextTraffic': 0x010104ec, 'theme': 0x01010000,
    'extractNativeLibs': 0x010104ea, 'screenOrientation': 0x0101001e,
    'configChanges': 0x0101001f, 'launchMode': 0x0101001d,
    'windowSoftInputMode': 0x0101022b,
}
THEME_BLACK_NO_TITLE_FULLSCREEN = 0x0103000a
ICON = 0x7f010000

p16 = lambda v: struct.pack('<H', v)
p32 = lambda v: struct.pack('<I', v)
p8 = lambda v: struct.pack('<B', v)


def chunk(ctype, header_size, body, size=None):
    return p16(ctype) + p16(header_size) + p32(size if size is not None else 8 + len(body)) + body


def varint(n):
    return bytes([n]) if n < 0x80 else bytes([0x80 | (n >> 8), n & 0xff])


def strpool(strings):
    offsets, data = [], b''
    for s in strings:
        offsets.append(len(data))
        enc = s.encode('utf-8')
        units = len(s.encode('utf-16-le')) // 2
        data += varint(units) + varint(len(enc)) + enc + b'\x00'
    while len(data) % 4:
        data += b'\x00'
    offs = b''.join(p32(o) for o in offsets)
    strings_start = 28 + len(offs)
    body = p32(len(strings)) + p32(0) + p32(0x100) + p32(strings_start) + p32(0)
    return chunk(0x0001, 28, body + offs + data)


class Ref:
    def __init__(self, rid): self.id = rid


class AXML:
    """A very small binary-XML writer: element tree in, AXML bytes out."""

    def __init__(self, attr_order):
        self.attr_order = attr_order
        self.other, self.other_idx = [], {}
        self.body = b''

    def o(self, s):
        if s not in self.other_idx:
            self.other_idx[s] = len(self.other)
            self.other.append(s)
        return len(self.attr_order) + self.other_idx[s]

    def a(self, name):
        return self.attr_order.index(name)

    def value(self, v):
        if isinstance(v, Ref): return 0x01, v.id, 0xffffffff
        if isinstance(v, bool): return 0x12, 0xffffffff if v else 0, 0xffffffff
        if isinstance(v, int): return 0x10, v, 0xffffffff
        i = self.o(v)
        return 0x03, i, i

    def start(self, ns, name, attrs):
        nsi = 0xffffffff if ns is None else self.o(ANDROID_NS)
        namei = self.o(name)
        head = p32(1) + p32(0xffffffff) + p32(nsi) + p32(namei)
        head += p16(20) + p16(20) + p16(len(attrs)) + p16(0) + p16(0) + p16(0)
        out = b''
        for ans, aname, aval in attrs:
            ni = 0xffffffff if ans is None else self.o(ANDROID_NS)
            dt, data, raw = self.value(aval)
            out += p32(ni) + p32(self.a(aname) if ans else self.o(aname)) + p32(raw)
            out += p16(8) + b'\x00' + p8(dt) + p32(data)
        self.body += chunk(0x0102, 16, head + out)

    def end(self, ns, name):
        nsi = 0xffffffff if ns is None else self.o(ANDROID_NS)
        body = p32(1) + p32(0xffffffff) + p32(nsi) + p32(self.o(name))
        self.body += chunk(0x0103, 16, body)

    def element(self, ns, name, attrs, children=()):
        self.start(ns, name, attrs)
        for c in children:
            self.element(*c) if len(c) == 4 else self.element(c[0], c[1], c[2], c[3] if len(c) > 3 else ())
        self.end(ns, name)

    def build(self, tree=None):
        prefix = self.o('android')
        uri = self.o(ANDROID_NS)
        prologue = chunk(0x0100, 16, p32(1) + p32(0xffffffff) + p32(prefix) + p32(uri))
        if tree is not None:
            self.element(*tree)
        epilogue = chunk(0x0101, 16, p32(1) + p32(0xffffffff) + p32(prefix) + p32(uri))
        strings = self.attr_order + self.other
        pool = strpool(strings)
        resmap = b''.join(p32(ATTR_ID[a]) for a in self.attr_order)
        resmap_chunk = chunk(0x0180, 8, resmap)
        content = pool + resmap_chunk + prologue + self.body + epilogue
        return p16(0x0003) + p16(8) + p32(8 + len(content)) + content


def build_manifest():
    app_attrs = [
        ('android', 'label', 'فكسب سمارت سيتي'),
        ('android', 'icon', Ref(ICON)),
        ('android', 'roundIcon', Ref(ICON)),
        ('android', 'allowBackup', True),
        ('android', 'supportsRtl', True),
        ('android', 'hardwareAccelerated', True),
        ('android', 'usesCleartextTraffic', False),
        ('android', 'extractNativeLibs', False),
        ('android', 'theme', Ref(THEME_BLACK_NO_TITLE_FULLSCREEN)),
    ]
    act_attrs = [
        ('android', 'name', '.MainActivity'),
        ('android', 'exported', True),
        ('android', 'screenOrientation', 1),          # portrait
        ('android', 'configChanges', 0xFA0),          # orientation|screenSize|keyboardHidden|uiMode|smallestScreenSize|screenLayout
        ('android', 'launchMode', 2),                 # singleTask
        ('android', 'windowSoftInputMode', 0x10),     # adjustResize
    ]
    tree = ('manifest', None, [('versionCode', 1), ('versionName', '2.0.0')], None)
    # element(ns, name, attrs, children) with unqualified `package`
    order = ['versionCode', 'versionName', 'minSdkVersion', 'targetSdkVersion', 'label',
             'icon', 'roundIcon', 'name', 'exported', 'allowBackup', 'supportsRtl',
             'hardwareAccelerated', 'usesCleartextTraffic', 'theme', 'extractNativeLibs',
             'screenOrientation', 'configChanges', 'launchMode', 'windowSoftInputMode']
    b = AXML(order)
    b.start(None, 'manifest', [(None, 'package', 'com.faksab.smartcity')] +
            [(ANDROID_NS, 'versionCode', 1), (ANDROID_NS, 'versionName', '2.0.0')])
    b.start(None, 'uses-sdk', [(ANDROID_NS, 'minSdkVersion', 24),
                                     (ANDROID_NS, 'targetSdkVersion', 34)])
    b.end(None, 'uses-sdk')
    b.start(None, 'application', app_attrs)
    b.start(None, 'activity', act_attrs)
    b.start(None, 'intent-filter', [])
    b.start(None, 'action', [(ANDROID_NS, 'name', 'android.intent.action.MAIN')])
    b.end(None, 'action')
    b.start(None, 'category', [(ANDROID_NS, 'name', 'android.intent.category.LAUNCHER')])
    b.end(None, 'category')
    b.end(None, 'intent-filter')
    b.end(None, 'activity')
    b.end(None, 'application')
    b.end(None, 'manifest')
    return b.build(None)


def build_arsc(path, density=640, type_name='mipmap', key_name='ic_launcher'):
    value_pool = strpool([path])
    type_pool = strpool([type_name])
    key_pool = strpool([key_name])

    spec_body = p8(1) + p8(0) + p16(0) + p32(1) + p32(0)
    spec = chunk(0x0202, 16, spec_body)

    config = bytearray(64)
    struct.pack_into('<I', config, 0, 64)      # size
    struct.pack_into('<H', config, 14, density)  # density
    entry = p16(8) + p16(0) + p32(0) + p16(8) + b'\x00' + p8(0x03) + p32(0)
    entries_start = 20 + len(config) + 4
    type_body = p8(1) + p8(0) + p16(0) + p32(1) + p32(entries_start) + bytes(config)
    type_body += p32(0) + entry
    typ = chunk(0x0201, 20 + len(config), type_body)

    pkg_body = p32(0x7f) + 'com.faksab.smartcity'.encode('utf-16-le').ljust(256, b'\x00')
    pkg_body += p32(288) + p32(1)
    pkg_body += p32(288 + len(type_pool)) + p32(1) + p32(0)
    pkg_body += type_pool + key_pool + spec + typ
    pkg = chunk(0x0200, 288, pkg_body)

    content = p32(1) + value_pool + pkg
    return p16(0x0002) + p16(12) + p32(8 + len(content)) + content


def write_zip(path, entries):
    """entries: list of (name, data, stored: bool). First entry is 4-aligned."""
    out = bytearray()
    central = []
    for name, data, stored in entries:
        raw = name.encode('utf-8')
        crc = zlib.crc32(data) & 0xffffffff
        if stored:
            payload, method = data, 0
        else:
            co = zlib.compressobj(9, zlib.DEFLATED, -15)
            payload = co.compress(data) + co.flush()
            method = 8
        offset = len(out)
        out += p32(0x04034b50) + p16(20) + p16(0) + p16(method) + p16(0) + p16(0x21)
        out += p32(crc) + p32(len(payload)) + p32(len(data)) + p16(len(raw)) + p16(0)
        out += raw + payload
        central.append((raw, method, crc, len(payload), len(data), offset))
    cd_start = len(out)
    for raw, method, crc, clen, ulen, off in central:
        out += p32(0x02014b50) + p16(0x0314) + p16(20) + p16(0) + p16(method)
        out += p16(0) + p16(0x21) + p32(crc) + p32(clen) + p32(ulen)
        out += p16(len(raw)) + p16(0) + p16(0) + p16(0) + p16(0) + p32(0) + p32(off) + raw
    cd_size = len(out) - cd_start
    out += p32(0x06054b50) + p16(0) + p16(0) + p16(len(central)) + p16(len(central))
    out += p32(cd_size) + p32(cd_start) + p16(0)
    pathlib.Path(path).write_bytes(bytes(out))


def run(cmd, **kw):
    r = subprocess.run(cmd, capture_output=True, text=True, **kw)
    if r.returncode != 0:
        print(r.stdout, r.stderr)
        raise SystemExit('FAILED: ' + ' '.join(map(str, cmd)))
    return r


def main():
    BUILD.mkdir(exist_ok=True)
    (BUILD / 'dex').mkdir(exist_ok=True)
    (BUILD / 'classes').mkdir(exist_ok=True)

    java = str(JDK / 'java')
    javac = str(JDK / 'javac')
    keytool = str(JDK / 'keytool')

    run([javac, '-source', '8', '-target', '8', '-bootclasspath', str(ANDROID_JAR),
         '-d', str(BUILD / 'classes'), str(ROOT / 'android/src/com/faksab/smartcity/MainActivity.java')])
    run([java, '-cp', str(D8), 'com.android.tools.r8.D8', '--min-api', '24',
         '--lib', str(ANDROID_JAR), '--output', str(BUILD / 'dex'),
         str(BUILD / 'classes/com/faksab/smartcity/MainActivity.class'),
         str(BUILD / 'classes/com/faksab/smartcity/MainActivity$1.class')])

    manifest = build_manifest()
    arsc = build_arsc('res/mipmap-xxxhdpi/ic_launcher.png')
    (BUILD / 'AndroidManifest.xml').write_bytes(manifest)
    (BUILD / 'resources.arsc').write_bytes(arsc)
    print('manifest', len(manifest), 'arsc', len(arsc))

    icon = (ROOT / 'android/icon-launcher-512.png').read_bytes()
    # the PWA links point at files that only exist in the web bundle
    assets_index = (ROOT / 'index.html').read_text(encoding='utf-8')
    assets_index = '\n'.join(l for l in assets_index.split('\n')
                              if 'rel="manifest"' not in l and 'rel="icon"' not in l
                              and 'rel="apple-touch-icon"' not in l)
    assets_index = assets_index.encode('utf-8')

    entries = [
        ('resources.arsc', arsc, True),          # must stay first: 4-aligned + stored
        ('AndroidManifest.xml', manifest, False),
        ('classes.dex', (BUILD / 'dex/classes.dex').read_bytes(), False),
        ('res/mipmap-xxxhdpi/ic_launcher.png', icon, False),
        ('assets/index.html', assets_index, False),
    ]
    unsigned = BUILD / 'app-unsigned.apk'
    write_zip(unsigned, entries)

    ks = ROOT / 'signing/faksab.keystore'
    ks.parent.mkdir(exist_ok=True)
    pw_file = ks.parent / 'keystore.pass'
    if not ks.exists():
        import secrets
        pw = secrets.token_urlsafe(18)
        pw_file.write_text(pw)
        run([keytool, '-genkeypair', '-keystore', str(ks), '-alias', 'faksab',
             '-keyalg', 'RSA', '-keysize', '2048', '-validity', '10000',
             '-storepass', pw, '-keypass', pw,
             '-dname', 'CN=Faksab Smart City, O=Faksab, C=SA'])
    pw = pw_file.read_text().strip()

    signed = ROOT / 'faksab-smart-city.apk'
    run([java, '-jar', str(APKSIGNER), 'sign', '--ks', str(ks), '--ks-key-alias', 'faksab',
         '--ks-pass', 'pass:' + pw, '--key-pass', 'pass:' + pw,
         '--v1-signing-enabled', 'false', '--v2-signing-enabled', 'true',
         '--v3-signing-enabled', 'true', '--min-sdk-version', '24',
         '--out', str(signed), str(unsigned)])
    run([java, '-jar', str(APKSIGNER), 'verify', '-v', '--print-certs', str(signed)])
    print('OK', signed, signed.stat().st_size)


if __name__ == '__main__':
    main()
