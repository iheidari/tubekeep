#!/bin/bash
set -e

echo "🚀 Setting up Caddy as the main reverse proxy..."
echo ""

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Function to print colored messages
print_status() {
    echo -e "${GREEN}✓${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}⚠${NC} $1"
}

print_error() {
    echo -e "${RED}✗${NC} $1"
}

# Check if running as root (should NOT be root for most operations)
if [ "$EUID" -eq 0 ]; then 
   print_error "Do not run this script as root/sudo. Run as your regular user."
   exit 1
fi

# Check if snap nextcloud is installed
if ! snap list | grep -q nextcloud; then
    print_error "Nextcloud snap not found. Is Nextcloud installed?"
    exit 1
fi

print_status "Nextcloud snap found"

# Step 1: Stop Nextcloud temporarily
echo ""
echo "📦 Step 1: Stopping Nextcloud temporarily..."
sudo snap stop nextcloud
print_status "Nextcloud stopped"

# Step 2: Change Nextcloud ports
echo ""
echo "📦 Step 2: Reconfiguring Nextcloud to use ports 8080/8443..."
sudo snap set nextcloud ports.http=8080
sudo snap set nextcloud ports.https=8443
print_status "Nextcloud ports changed to 8080/8443"

# Step 3: Install Caddy if not already installed
echo ""
echo "📦 Step 3: Installing Caddy..."
if ! command -v caddy &> /dev/null; then
    print_status "Caddy not found, installing..."
    
    # Install dependencies
    sudo apt update
    sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
    
    # Add Caddy repository
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
    
    # Install Caddy
    sudo apt update
    sudo apt install -y caddy
    
    print_status "Caddy installed successfully"
else
    print_status "Caddy is already installed"
fi

# Step 4: Create the main Caddyfile
echo ""
echo "📦 Step 4: Creating Caddyfile configuration..."

CADDYFILE_CONTENT='ytd.heidari.ca {
    # Static frontend files
    root * /data/ytd/frontend/dist
    file_server
    
    # API routes to backend
    reverse_proxy /api/* localhost:3001
    
    # Handle React Router (SPA)
    try_files {path} /index.html
    
    # Security headers
    header {
        X-Content-Type-Options nosniff
        X-Frame-Options DENY
        X-XSS-Protection "1; mode=block"
        Referrer-Policy strict-origin-when-cross-origin
        Strict-Transport-Security "max-age=31536000; includeSubDomains; preload"
    }
    
    # Cache static assets
    @static {
        path *.css *.js *.png *.jpg *.jpeg *.gif *.svg *.woff *.woff2 *.ico
    }
    header @static Cache-Control "public, max-age=31536000, immutable"
    
    # Gzip compression
    encode gzip
    
    # Logging
    log {
        output file /data/ytd/logs/caddy-access-ytd.log
        format json
    }
}

cloud.heidari.ca {
    reverse_proxy localhost:8080 {
        header_up Host {host}
        header_up X-Real-IP {remote}
        
        # WebSocket support for Nextcloud
        header_up Upgrade {http_upgrade}
        header_up Connection {http_connection}
    }
    
    # Logging
    log {
        output file /data/ytd/logs/caddy-access-cloud.log
        format json
    }
}
'

# Backup existing Caddyfile
if [ -f /etc/caddy/Caddyfile ]; then
    sudo cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.backup.$(date +%Y%m%d_%H%M%S)
    print_status "Existing Caddyfile backed up"
fi

# Write the new Caddyfile
echo "$CADDYFILE_CONTENT" | sudo tee /etc/caddy/Caddyfile > /dev/null
print_status "Caddyfile created at /etc/caddy/Caddyfile"

# Step 5: Start Nextcloud
echo ""
echo "📦 Step 5: Starting Nextcloud with new ports..."
sudo snap start nextcloud

# Wait for Nextcloud to be ready
print_status "Waiting for Nextcloud to start (this may take 30-60 seconds)..."
sleep 30

# Check if Nextcloud is responding on port 8080
if curl -s -o /dev/null -w "%{http_code}" http://localhost:8080 | grep -q "200\|302\|401"; then
    print_status "Nextcloud is running on port 8080"
else
    print_warning "Nextcloud may still be starting. Waiting another 30 seconds..."
    sleep 30
    if curl -s -o /dev/null -w "%{http_code}" http://localhost:8080 | grep -q "200\|302\|401"; then
        print_status "Nextcloud is now running on port 8080"
    else
        print_error "Nextcloud may not be responding on port 8080. Check 'sudo snap logs nextcloud'"
    fi
fi

# Step 6: Update Nextcloud trusted domains
echo ""
echo "📦 Step 6: Adding cloud.heidari.ca to Nextcloud trusted domains..."

# Get current trusted domains
CURRENT_TRUSTED=$(sudo nextcloud.occ config:system:get trusted_domains 2>/dev/null || echo "")

# Check if cloud.heidari.ca is already in the list
if echo "$CURRENT_TRUSTED" | grep -q "cloud.heidari.ca"; then
    print_status "cloud.heidari.ca is already in trusted domains"
else
    # Add cloud.heidari.ca to trusted domains
    # Find the next available index
    INDEX=0
    while sudo nextcloud.occ config:system:get trusted_domains $INDEX &>/dev/null; do
        INDEX=$((INDEX + 1))
    done
    
    sudo nextcloud.occ config:system:set trusted_domains $INDEX --value=cloud.heidari.ca
    print_status "Added cloud.heidari.ca to Nextcloud trusted domains (index $INDEX)"
fi

# Also ensure localhost is trusted (for internal connections)
if ! echo "$CURRENT_TRUSTED" | grep -q "localhost"; then
    INDEX=0
    while sudo nextcloud.occ config:system:get trusted_domains $INDEX &>/dev/null; do
        INDEX=$((INDEX + 1))
    done
    sudo nextcloud.occ config:system:set trusted_domains $INDEX --value=localhost
    print_status "Added localhost to Nextcloud trusted domains"
fi

# Step 7: Start Caddy
echo ""
echo "📦 Step 7: Starting Caddy..."

# Validate Caddyfile
if sudo caddy validate --config /etc/caddy/Caddyfile; then
    print_status "Caddyfile is valid"
else
    print_error "Caddyfile validation failed. Please check the configuration."
    exit 1
fi

# Reload or start Caddy
sudo systemctl restart caddy
sudo systemctl enable caddy

# Check Caddy status
if sudo systemctl is-active --quiet caddy; then
    print_status "Caddy is running successfully"
else
    print_error "Caddy failed to start. Check logs with: sudo journalctl -u caddy -f"
    exit 1
fi

# Step 8: Test the services
echo ""
echo "📦 Step 8: Testing services..."

# Test yt-downloader backend
if curl -s http://localhost:3001/health | grep -q "ok"; then
    print_status "yt-downloader backend is responding"
else
    print_warning "yt-downloader backend may not be running. Start it with: pm2 start deploy/ecosystem.config.js"
fi

# Test Caddy on port 80
echo ""
echo "🧪 Testing HTTP endpoints..."
YTD_TEST=$(curl -s -o /dev/null -w "%{http_code}" -H "Host: ytd.heidari.ca" http://localhost || echo "failed")
CLOUD_TEST=$(curl -s -o /dev/null -w "%{http_code}" -H "Host: cloud.heidari.ca" http://localhost || echo "failed")

echo "  - ytd.heidari.ca via Caddy: HTTP $YTD_TEST"
echo "  - cloud.heidari.ca via Caddy: HTTP $CLOUD_TEST"

# Final summary
echo ""
echo "========================================"
echo "✅ Setup Complete!"
echo "========================================"
echo ""
echo "Services configured:"
echo "  🌐 https://ytd.heidari.ca    → yt-downloader app"
echo "  🌐 https://cloud.heidari.ca   → Nextcloud"
echo ""
echo "Important notes:"
echo "  • Caddy will automatically obtain HTTPS certificates"
echo "  • It may take 1-2 minutes for certificates to be issued"
echo "  • Nextcloud is now running on port 8080 (behind Caddy)"
echo "  • Caddy handles all traffic on ports 80/443"
echo ""
echo "Useful commands:"
echo "  sudo systemctl status caddy     - Check Caddy status"
echo "  sudo systemctl restart caddy  - Restart Caddy"
echo "  sudo caddy reload             - Reload Caddy config"
echo "  pm2 status                    - Check yt-downloader"
echo "  sudo snap logs nextcloud      - Check Nextcloud logs"
echo ""
echo "Troubleshooting:"
echo "  • If HTTPS doesn't work immediately, wait 2-3 minutes for certificate issuance"
echo "  • Check Caddy logs: sudo journalctl -u caddy -f"
echo "  • Ensure your DNS A records point to this server's IP"
echo ""
