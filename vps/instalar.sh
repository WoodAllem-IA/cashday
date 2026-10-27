#!/usr/bin/env bash
# Instala a Evolution API na VPS para o CashDay.
# Uso (como root, na VPS):
#   curl -fsSL https://raw.githubusercontent.com/WoodAllem-IA/cashday/main/vps/instalar.sh | bash
set -euo pipefail

PASTA=/opt/cashday-evolution
REPO=https://raw.githubusercontent.com/WoodAllem-IA/cashday/main/vps

echo "== Instalando a Evolution API do CashDay =="

if [ "$(id -u)" -ne 0 ]; then echo "Rode como root (ou com sudo)."; exit 1; fi

if ! command -v docker >/dev/null 2>&1; then
  echo "-> Instalando o Docker..."
  curl -fsSL https://get.docker.com | sh
fi
if ! docker compose version >/dev/null 2>&1; then echo "O Docker Compose não está disponível. Atualize o Docker e rode de novo."; exit 1; fi

if ss -ltn 2>/dev/null | grep -qE ':(80|443)\s'; then
  if [ ! -f "$PASTA/.env" ]; then
    echo "AVISO: as portas 80 ou 443 já estão em uso nesta VPS (outro site ou painel)."
    echo "Este instalador precisa delas livres. Pare aqui e fale com o Claude no CashDay."
    exit 1
  fi
fi

mkdir -p "$PASTA" && cd "$PASTA"
curl -fsSL "$REPO/docker-compose.yml" -o docker-compose.yml
curl -fsSL "$REPO/Caddyfile" -o Caddyfile

if [ ! -f .env ]; then
  IP=$(curl -fsS4 https://api.ipify.org)
  DOMINIO="$(echo "$IP" | tr . -).sslip.io"
  APIKEY=$(openssl rand -hex 24)
  PGSENHA=$(openssl rand -hex 16)
  printf 'DOMINIO=%s\nEVOLUTION_APIKEY=%s\nPOSTGRES_SENHA=%s\n' "$DOMINIO" "$APIKEY" "$PGSENHA" > .env
  chmod 600 .env
fi
. ./.env

if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then ufw allow 80/tcp && ufw allow 443/tcp; fi

docker compose pull
docker compose up -d

echo
echo "== Pronto! Aguarde 1 ou 2 minutos e abra no navegador: =="
echo "   Painel da Evolution:  https://$DOMINIO/manager"
echo "   Endereço (EVOLUTION_URL):    https://$DOMINIO"
echo "   Chave (EVOLUTION_APIKEY):    $EVOLUTION_APIKEY"
echo
echo "Guarde a chave num lugar seguro. NÃO mande ela no chat."
echo "Para ver a chave de novo: cat $PASTA/.env"
