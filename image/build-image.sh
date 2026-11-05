#!/usr/bin/env bash
# Builds a flash-and-boot Raspberry Pi SD card image for the Howth CG dashboard.
#
# Runs as root on an x86_64 or arm64 Debian/Ubuntu host (GitHub Actions ubuntu-latest
# works) with: qemu-user-static binfmt-support xz-utils parted e2fsprogs curl
#
# Usage: image/build-image.sh <path-to-built-app-dir> <output.img>
#   <app-dir> must contain: server/dist web/dist node_modules server/node_modules
#             server/package.json config.yaml
set -euo pipefail

APP_SRC=${1:?app dir}
OUT=${2:?output image path}
HERE=$(cd "$(dirname "$0")" && pwd)
WORK=${WORK:-$(mktemp -d)}
PI_OS_URL=${PI_OS_URL:-https://downloads.raspberrypi.com/raspios_lite_arm64_latest}
NODE_VERSION=${NODE_VERSION:-22.22.0}
GROW_MB=${GROW_MB:-2560}
# Default login for the image (userconf.txt). Override via env when building.
IMG_USER=${IMG_USER:-cg}
IMG_PASS=${IMG_PASS:-howthcg}
HOSTNAME_PI=${HOSTNAME_PI:-howth-cg}

log() { echo "==> $*"; }
[ "$(id -u)" = 0 ] || { echo "run as root"; exit 1; }

cleanup() {
  set +e
  for m in dev/pts dev proc sys run boot/firmware; do umount -l "$WORK/root/$m" 2>/dev/null; done
  umount -l "$WORK/root" 2>/dev/null
  [ -n "${LOOP:-}" ] && losetup -d "$LOOP" 2>/dev/null
}
trap cleanup EXIT

mkdir -p "$WORK/root"
cd "$WORK"

# ---------------------------------------------------------------- base image
if [ ! -f base.img ]; then
  log "downloading Raspberry Pi OS Lite (arm64)"
  curl -fL --retry 3 -o base.img.xz "$PI_OS_URL"
  log "decompressing"
  xz -d -T0 base.img.xz
fi
cp --reflink=auto base.img image.img
log "growing image by ${GROW_MB} MB"
truncate -s "+${GROW_MB}M" image.img
parted -s image.img resizepart 2 100%
LOOP=$(losetup -fP --show image.img)
log "loop device $LOOP"
e2fsck -fy "${LOOP}p2" || true
resize2fs "${LOOP}p2"

mount "${LOOP}p2" "$WORK/root"
mkdir -p "$WORK/root/boot/firmware"
mount "${LOOP}p1" "$WORK/root/boot/firmware"
ROOT="$WORK/root"
BOOT="$ROOT/boot/firmware"

# ---------------------------------------------------------------- chroot prep
log "preparing chroot"
ARCH_HOST=$(uname -m)
QEMU_COPIED=
if [ "$ARCH_HOST" != "aarch64" ]; then
  # Newer distros register qemu with the binfmt "F" flag (binary pre-opened), in
  # which case nothing needs copying into the chroot. Otherwise copy the static one.
  if ! grep -qs '^flags:.*F' /proc/sys/fs/binfmt_misc/qemu-aarch64; then
    QEMU_BIN=$(command -v qemu-aarch64-static || command -v qemu-aarch64 || true)
    [ -n "$QEMU_BIN" ] || { echo "no qemu-aarch64 user emulator found"; exit 1; }
    cp "$QEMU_BIN" "$ROOT/usr/bin/qemu-aarch64-static"
    QEMU_COPIED=1
  fi
fi
# libarmmem preload breaks emulated chroots; park it.
[ -f "$ROOT/etc/ld.so.preload" ] && mv "$ROOT/etc/ld.so.preload" "$ROOT/etc/ld.so.preload.disabled"
mount -t proc proc "$ROOT/proc"
mount --bind /sys "$ROOT/sys"
mount --bind /dev "$ROOT/dev"
mount --bind /dev/pts "$ROOT/dev/pts"
mount -t tmpfs tmpfs "$ROOT/run"
cp -a "$ROOT/etc/resolv.conf" "$WORK/resolv.conf.orig" 2>/dev/null || true
rm -f "$ROOT/etc/resolv.conf"; cp /etc/resolv.conf "$ROOT/etc/resolv.conf"
chr() { chroot "$ROOT" /usr/bin/env PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin DEBIAN_FRONTEND=noninteractive LC_ALL=C "$@"; }

# ---------------------------------------------------------------- packages
log "installing packages (chromium + cage under emulation: this takes a while)"
chr apt-get update
chr apt-get install -y --no-install-recommends \
  cage chromium libgl1-mesa-dri \
  fonts-dejavu fonts-liberation2 curl ca-certificates xz-utils \
  dbus-user-session libegl1 libgles2
chr apt-get clean
rm -rf "$ROOT/var/lib/apt/lists/"*

# ---------------------------------------------------------------- node
log "installing Node $NODE_VERSION"
curl -fL --retry 3 -o node.tar.xz "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-arm64.tar.xz"
tar -xJf node.tar.xz -C "$ROOT/usr/local" --strip-components=1 --exclude='*/share' --exclude='*/include' --exclude='*/lib/node_modules/npm'
rm -f "$ROOT/usr/local/bin/npm" "$ROOT/usr/local/bin/npx" "$ROOT/usr/local/bin/corepack"

# ---------------------------------------------------------------- users
log "creating users"
for g in howthcg video render input audio; do chr groupadd -f "$g"; done
chr id howthcg >/dev/null 2>&1 || chr useradd -r -g howthcg -d /var/lib/howth-cg -s /usr/sbin/nologin howthcg
chr id kiosk >/dev/null 2>&1 || chr useradd -m -d /home/kiosk -s /bin/bash -G video,render,input,audio kiosk
mkdir -p "$ROOT/var/lib/howth-cg" && chr chown howthcg:howthcg /var/lib/howth-cg

# ---------------------------------------------------------------- app
log "installing app"
APP="$ROOT/opt/howth-cg"
mkdir -p "$APP/server" "$APP/web"
cp -r "$APP_SRC/server/dist" "$APP/server/dist"
cp "$APP_SRC/server/package.json" "$APP/server/package.json"
cp -r "$APP_SRC/web/dist" "$APP/web/dist"
cp -r "$APP_SRC/node_modules" "$APP/node_modules"
[ -d "$APP_SRC/server/node_modules" ] && cp -r "$APP_SRC/server/node_modules" "$APP/server/node_modules"
cp -r "$HERE/rootfs/." "$ROOT/"
mkdir -p "$ROOT/etc/howth-cg"
cp "$APP_SRC/config.yaml" "$ROOT/etc/howth-cg/config.yaml"
chmod +x "$APP"/bin/*.sh
chr chown -R root:root /opt/howth-cg
# Build stamp
echo "built $(date -u +%Y-%m-%dT%H:%M:%SZ) node=$NODE_VERSION" > "$APP/BUILD"

# ---------------------------------------------------------------- services
log "enabling services"
chr systemctl enable howth-cg-dashboard.service howth-cg-kiosk.service howth-cg-wifi.service
# The kiosk owns tty1. Masking (not just disabling) stops logind/getty.target
# from spawning a login prompt there, which would Conflict= the kiosk away.
chr systemctl mask getty@tty1.service
# Wi-Fi: regulatory domain so the radio isn't rfkill-blocked on first boot.
echo "REGDOMAIN=IE" > "$ROOT/etc/default/crda" 2>/dev/null || true
chr sh -c 'command -v raspi-config >/dev/null && raspi-config nonint do_wifi_country IE' || true
# No need for the first-boot wizard on Lite; keep resize + userconf behaviour.

# ---------------------------------------------------------------- boot partition
log "writing boot partition files"
cp "$HERE/boot/howth-cg.env" "$BOOT/howth-cg.env"
cp "$HERE/boot/README-howth-cg.txt" "$BOOT/README-howth-cg.txt"
cp "$HERE/boot/howth-cg-wifi.conf.example" "$BOOT/howth-cg-wifi.conf.example"
cp "$HERE/boot/network-config.example" "$BOOT/network-config.example"
cp "$HERE/boot/user-data.example" "$BOOT/user-data.example"
touch "$BOOT/ssh"
# default login user (Raspberry Pi OS userconf mechanism); Imager customisation overrides
PASS_HASH=$(openssl passwd -6 "$IMG_PASS")
echo "${IMG_USER}:${PASS_HASH}" > "$BOOT/userconf.txt"
echo "$HOSTNAME_PI" > "$ROOT/etc/hostname"
sed -i "s/127.0.1.1.*/127.0.1.1\t$HOSTNAME_PI/" "$ROOT/etc/hosts" || true
# 1080p60 on HDMI0, no console blanking, quiet boot
CMD="$BOOT/cmdline.txt"
sed -i 's/[[:space:]]*$//' "$CMD"
grep -q 'video=HDMI-A-1' "$CMD" || sed -i '1 s/$/ video=HDMI-A-1:1920x1080@60D consoleblank=0 quiet loglevel=3 vt.global_cursor_default=0/' "$CMD"
# config.txt: force HDMI hotplug so it boots headless-then-plugged, disable overscan
CFG="$BOOT/config.txt"
grep -q '^hdmi_force_hotplug' "$CFG" || printf '\n# howth-cg\nhdmi_force_hotplug=1\ndisable_overscan=1\n' >> "$CFG"
# Timezone + locale
echo "Europe/Dublin" > "$ROOT/etc/timezone"
ln -sf /usr/share/zoneinfo/Europe/Dublin "$ROOT/etc/localtime"

# ---------------------------------------------------------------- finish
log "cleaning up chroot"
[ -f "$ROOT/etc/ld.so.preload.disabled" ] && mv "$ROOT/etc/ld.so.preload.disabled" "$ROOT/etc/ld.so.preload"
[ -n "$QEMU_COPIED" ] && rm -f "$ROOT/usr/bin/qemu-aarch64-static"
rm -f "$ROOT/etc/resolv.conf"; [ -e "$WORK/resolv.conf.orig" ] && cp -a "$WORK/resolv.conf.orig" "$ROOT/etc/resolv.conf"
sync
for m in dev/pts dev proc sys run boot/firmware; do umount -l "$ROOT/$m"; done
umount "$ROOT"
losetup -d "$LOOP"; LOOP=
log "compressing"
mv image.img "$OUT"
xz -T0 -6 -f "$OUT"
ls -lh "$OUT.xz"
log "done: $OUT.xz"
