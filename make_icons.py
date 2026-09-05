# 生成扩展图标（纯 Python，无第三方依赖）
import struct, zlib, os

def make_png(size, path):
    # 背景：蓝色圆角底 + 白色信号波纹 + 中心圆点（简化为像素绘制）
    px = bytearray(size * size * 4)
    cx = cy = (size - 1) / 2
    r_outer = size * 0.46
    for y in range(size):
        for x in range(size):
            i = (y * size + x) * 4
            dx, dy = x - cx, y - cy
            d = (dx * dx + dy * dy) ** 0.5
            # 圆角底
            if d > r_outer:
                continue
            # 渐变蓝底
            t = d / r_outer
            r, g, b = int(37 + t * 30), int(99 + t * 40), int(235 + t * 10)
            # 白色圆弧波纹（三圈）
            for arc_r, w in ((r_outer * 0.72, max(1, size // 18)),
                             (r_outer * 0.45, max(1, size // 16)),
                             (r_outer * 0.18, max(1, size // 10))):
                if abs(d - arc_r) < w / 2:
                    # 只画上半部分（信号波朝上）
                    if dy <= size * 0.05:
                        r, g, b = 255, 255, 255
            px[i:i + 4] = bytes((r, g, b, 255))
    raw = b''.join(b'\x00' + bytes(px[y * size * 4:(y + 1) * size * 4]) for y in range(size))

    def chunk(tag, data):
        c = tag + data
        return struct.pack('>I', len(data)) + c + struct.pack('>I', zlib.crc32(c))

    png = (b'\x89PNG\r\n\x1a\n'
           + chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0))
           + chunk(b'IDAT', zlib.compress(raw, 9))
           + chunk(b'IEND', b''))
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'wb') as f:
        f.write(png)
    print('ok', path)

base = r'K:\vibecoding\media-sniffer\icons'
for s in (16, 32, 48, 128):
    make_png(s, os.path.join(base, f'icon{s}.png'))
