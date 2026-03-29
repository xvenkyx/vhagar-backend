#!/bin/bash
# ============================================
# Vhagar EC2 Bootstrap Script (UBUNTU)
# Use this for Ubuntu 22.04+ LTS Instances
# ============================================

set -e

NGROK_TOKEN="${1:?Usage: ./bootstrap-ubuntu.sh <NGROK_TOKEN> <NGROK_DOMAIN> <GH_PAT>}"
NGROK_DOMAIN="${2:?Usage: ./bootstrap-ubuntu.sh <NGROK_TOKEN> <NGROK_DOMAIN> <GH_PAT>}"
GH_PAT="${3:?Usage: ./bootstrap-ubuntu.sh <NGROK_TOKEN> <NGROK_DOMAIN> <GH_PAT>}"

echo "🚀 Bootstrapping Vhagar Ubuntu EC2 Instance..."

# 1. Update and install basic dependencies
sudo apt-get update -y
sudo apt-get install -y ca-certificates curl gnupg lsb-release git

# 2. Install Docker
echo "🐳 Installing Docker..."
sudo mkdir -p /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \
  $(lsb_release -cs) stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

sudo apt-get update -y
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
sudo systemctl start docker
sudo systemctl enable docker
sudo usermod -aG docker ubuntu

# 3. Install Ngrok via official repository (User-provided commands)
echo "🌐 Installing Ngrok via APT (Bookworm)..."
curl -sSL https://ngrok-agent.s3.amazonaws.com/ngrok.asc | sudo tee /etc/apt/trusted.gpg.d/ngrok.asc >/dev/null
echo "deb https://ngrok-agent.s3.amazonaws.com bookworm main" | sudo tee /etc/apt/sources.list.d/ngrok.list
sudo apt-get update && sudo apt-get install -y ngrok
ngrok config add-authtoken 3BZYuUQ6nHfPus47syssmNO5E0f_6NbTtaSBmseN9KoaubamK

# 4. Setup Ngrok systemd service
echo "⚙️ Setting up Ngrok systemd service..."
sudo bash -c "cat > /etc/systemd/system/ngrok.service <<EOF
[Unit]
Description=Ngrok Tunnel for Vhagar Unified Backend
After=network.target docker.service

[Service]
Type=simple
User=ubuntu
ExecStart=/usr/bin/ngrok http --domain=${NGROK_DOMAIN} 3000
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF"

sudo systemctl daemon-reload
sudo systemctl enable ngrok

# 5. Clone the repository
echo "📂 Cloning Vhagar Backend..."
if [ ! -d ~/ezzi-backend ]; then
  git clone "https://xvenkyx:${GH_PAT}@github.com/xvenkyx/vhagar-backend.git" ~/ezzi-backend
else
  echo "Repo already exists, pulling latest..."
  cd ~/ezzi-backend && git pull origin main
fi

echo ""
echo "============================================"
echo "✅ Bootstrap Complete!"
echo "============================================"
echo ""
echo "Next steps:"
echo ""
echo "  1. Log out and back in (for docker group):"
echo "     exit"
echo "     ssh -i ezzi-key.pem ubuntu@<IP>"
echo ""
echo "  2. Create .env file:"
echo "     cat > ~/ezzi-backend/.env << 'EOF'"
echo "     JWT_SECRET=your_jwt_secret"
echo "     AWS_REGION=ap-south-1"
echo "     AWS_ACCESS_KEY_ID=your_key"
echo "     AWS_SECRET_ACCESS_KEY=your_secret"
# Add any hardware ID stuff if necessary
echo "     PORT=3000"
echo "     EOF"
echo ""
echo "  3. Build & start the container:"
echo "     cd ~/ezzi-backend"
echo "     docker build -t vhagar-backend:latest ."
echo "     docker run -d --name vhagar-backend -p 3000:3000 --restart unless-stopped --env-file .env vhagar-backend:latest"
echo ""
echo "  4. Start ngrok tunnel:"
echo "     sudo systemctl start ngrok"
echo ""
echo "  5. Verify everything:"
echo "     curl http://localhost:3000/health"
echo "     curl https://${NGROK_DOMAIN}/health"
echo "============================================"
