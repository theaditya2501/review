#!/usr/bin/env bash
# ==============================================================================
# Production SSL / HTTPS Configuration Script for review.vexwick.store
# ==============================================================================
set -e

DOMAIN="review.vexwick.store"
EMAIL="theaditya2501@gmail.com"
NODE_PORT=3000

echo "=========================================================="
echo "🔐 Configuring SSL / HTTPS for ${DOMAIN}"
echo "=========================================================="

# Check for root / sudo privileges
if [ "$EUID" -ne 0 ]; then
  echo "❌ Please run as root or with sudo: sudo bash setup-ssl.sh"
  exit 1
fi

# Detect Package Manager
if command -v apt-get &> /dev/null; then
  echo "📦 Ubuntu / Debian detected. Updating repositories..."
  apt-get update -y
  apt-get install -y certbot nginx python3-certbot-nginx
elif command -v yum &> /dev/null; then
  echo "📦 Amazon Linux / CentOS detected. Updating repositories..."
  yum install -y epel-release || true
  yum install -y certbot nginx python3-certbot-nginx || amazon-linux-extras install -y epel && yum install -y certbot nginx
fi

# Ensure Nginx directory exists
mkdir -p /etc/nginx/conf.d

# 1. Create initial Nginx configuration for ACME challenge & HTTP reverse proxy
cat << 'EOF' > /etc/nginx/conf.d/review.vexwick.store.conf
server {
    listen 80;
    listen [::]:80;
    server_name review.vexwick.store;

    location /.well-known/acme-challenge/ {
        root /var/www/certbot;
    }

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }
}
EOF

mkdir -p /var/www/certbot
systemctl enable nginx || true
systemctl restart nginx || true

# 2. Obtain Let's Encrypt Certificate
echo "📜 Requesting Let's Encrypt TLS Certificate for ${DOMAIN}..."
if [ -d "/etc/letsencrypt/live/${DOMAIN}" ]; then
  echo "✓ Certificate already exists at /etc/letsencrypt/live/${DOMAIN}"
else
  certbot --nginx -d "${DOMAIN}" --non-interactive --agree-tos -m "${EMAIL}" --redirect || {
    echo "⚠️ Nginx plugin failed, attempting standalone certbot..."
    systemctl stop nginx || true
    certbot certonly --standalone -d "${DOMAIN}" --non-interactive --agree-tos -m "${EMAIL}"
    systemctl start nginx || true
  }
fi

# 3. Apply Hardened Production Nginx Configuration with HTTP -> HTTPS 301 Redirect
if [ -f "/etc/letsencrypt/live/${DOMAIN}/fullchain.pem" ]; then
  echo "🔧 Applying production SSL Nginx configuration with 301 HTTPS redirection..."
  cat << 'EOF' > /etc/nginx/conf.d/review.vexwick.store.conf
# HTTP -> HTTPS 301 Redirect
server {
    listen 80;
    listen [::]:80;
    server_name review.vexwick.store;

    location /.well-known/acme-challenge/ {
        root /var/www/certbot;
    }

    location / {
        return 301 https://$host$request_uri;
    }
}

# HTTPS Server with TLS 1.2 & 1.3
server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name review.vexwick.store;

    ssl_certificate /etc/letsencrypt/live/review.vexwick.store/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/review.vexwick.store/privkey.pem;

    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;
    ssl_prefer_server_ciphers on;
    ssl_session_cache shared:SSL:10m;
    ssl_session_timeout 1d;

    # Security Headers
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-XSS-Protection "1; mode=block" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_cache_bypass $http_upgrade;
    }
}
EOF

  nginx -t && systemctl restart nginx
  echo "✅ Nginx restarted with valid TLS certificate and HTTP->HTTPS redirect!"
fi

# 4. Ensure Certbot Automatic Renewal is active
systemctl enable certbot.timer || true
systemctl start certbot.timer || true

echo "=========================================================="
echo "🎉 HTTPS is now configured for https://${DOMAIN}"
echo "=========================================================="
