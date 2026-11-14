[1mdiff --git a/docker-compose.yml b/docker-compose.yml[m
[1mindex 0ba81f0..86317cb 100755[m
[1m--- a/docker-compose.yml[m
[1m+++ b/docker-compose.yml[m
[36m@@ -5,6 +5,11 @@[m
 #   - Tailscale installed and connected on the MacBook[m
 #   - Tailscale IP: 100.66.85.86[m
 #   - SSH access: ssh -i ~/.ssh/vreal_mirror_ed25519 macbook@192.168.86.110[m
[32m+[m[32m#   - 3.6 TB media drive mounted at /srv/media (bind-mounted for blocks only)[m
[32m+[m[32m#[m
[32m+[m[32m# Storage split:[m
[32m+[m[32m#   - Kubo config, DB, keystore, datastore → SSD named volume (kubo-data)[m
[32m+[m[32m#   - IPFS blockstore (pinned bytes) → HDD bind mount (/srv/media/kubo-blocks)[m
 #[m
 # Deploy: docker compose up -d[m
 # Verify: curl -sI http://100.66.85.86:8080/ipfs/<cid>[m
[36m@@ -21,32 +26,27 @@[m [mservices:[m
       - SETUID[m
       - SETGID[m
     volumes:[m
[31m-      - kubo-data:/data/ipfs[m
[32m+[m[32m      # Kubo config, DB, keystore, datastore → SSD (named volume)[m
[32m+[m[32m      - "kubo-data:/data/ipfs"[m
[32m+[m[32m      # IPFS blockstore (pinned bytes) → HDD (bind mount)[m
[32m+[m[32m      - "/srv/media/kubo-blocks:/data/ipfs/blocks"[m
     ports:[m
[31m-      # Bound exclusively to Tailscale IP — NOT 0.0.0.0[m
[32m+[m[32m      # Bound to Tailscale IP + MacBook LAN — NOT 0.0.0.0[m
[32m+[m[32m      # (LAN bindings let the Chromebook reach Kubo; its Tailscale[m
[32m+[m[32m      # runs in userspace-networking mode so TCP over 100.x fails.)[m
       - "100.66.85.86:4001:4001"[m
       - "100.66.85.86:4001:4001/udp"[m
       - "100.66.85.86:5001:5001"[m
       - "100.66.85.86:8080:8080"[m
[32m+[m[32m      - "192.168.86.110:5001:5001"[m
[32m+[m[32m      - "192.168.86.110:8080:8080"[m
     environment:[m
       - IPFS_PROFILE=server[m
[31m-    command: >[m
[31m-      sh -c "[m
[31m-        ipfs init --profile=server >/dev/null 2>&1 || true;[m
[31m-        ipfs config Addresses.API /ip4/0.0.0.0/tcp/5001;[m
[31m-        ipfs config Addresses.Gateway /ip4/0.0.0.0/tcp/8080;[m
[31m-        ipfs config --bool Gateway.NoFetch true;[m
[31m-        ipfs config --bool Gateway.NoDNSLink true;[m
[31m-        ipfs config --json Gateway.HTTPHeaders.Access-Control-Allow-Origin '[\"*\"]';[m
[31m-        ipfs config --json Gateway.HTTPHeaders.Access-Control-Allow-Methods '[\"GET\",\"HEAD\",\"OPTIONS\"]';[m
[31m-        ipfs config --json Gateway.HTTPHeaders.Access-Control-Allow-Headers '[\"Range\",\"If-Range\",\"X-Requested-With\"]';[m
[31m-        ipfs config --json Gateway.HTTPHeaders.Access-Control-Expose-Headers '[\"Content-Range\",\"Content-Length\",\"Accept-Ranges\",\"X-Ipfs-Path\",\"X-Ipfs-Roots\",\"Etag\"]';[m
[31m-        ipfs config --json Gateway.HTTPHeaders.X-Content-Type-Options '[\"nosniff\"]';[m
[31m-        ipfs config --json Gateway.HTTPHeaders.Content-Security-Policy '[\"default-src none; style-src unsafe-inline; sandbox\"]';[m
[31m-        exec ipfs daemon[m
[31m-      "[m
[32m+[m[32m    # Config is pre-baked in the named volume (from the original container).[m
[32m+[m[32m    # The kubo image's start_ipfs entrypoint runs `ipfs daemon` by default.[m
 [m
 volumes:[m
   kubo-data:[m
[31m-    driver: local[m
[31m-EOF[m
\ No newline at end of file[m
[32m+[m[32m    external: true[m
[32m+[m[32m    name: kubo-data[m
[32m+[m[32m# EOF[m
\ No newline at end of file[m
