mkdir -p /usr/share/glvnd/egl_vendor.d
echo '{"file_format_version":"1.0.0","ICD":{"library_path":"libEGL_nvidia.so.0"}}' > /usr/share/glvnd/egl_vendor.d/10_nvidia.json
cd /work
test -d node_modules/playwright || npm i playwright@1.55.0 >/dev/null 2>&1
node shoot.js
