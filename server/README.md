# Servidor do CashDay (Railway)

Guarda os dados no Postgres (com backups automáticos), guarda fotos e documentos
e roda o robô de cobrança pela Evolution API.

1. Railway: New Project > Deploy from GitHub repo > `WoodAllem-IA/cashday`.
2. No projeto: Create > Database > PostgreSQL.
3. No serviço `cashday` > Variables:
   - `DATABASE_URL` = `${{Postgres.DATABASE_URL}}`
   - `APP_SENHA` = a senha do administrador (entra com o usuário `admin`)
   - `ADMIN_USUARIO` (opcional) = troca o nome do usuário do administrador
   - `ADMIN_NOME` (opcional) = seu nome para a saudação "Olá, Senhor ..."
   - `EVOLUTION_URL` e `EVOLUTION_APIKEY` (a chave global, `AUTHENTICATION_API_KEY` da Evolution), para o envio automático
   - `EVOLUTION_INSTANCIA` (opcional) = instância já conectada que o administrador quer continuar usando
   - `HORARIO_COBRANCA` (opcional) = horário padrão, ex.: `09:00`, para a conta que ainda não escolheu o dela
   - `ENVIO_AUTOMATICO` (opcional) = `sim` ou `nao`, padrão para a conta que ainda não ligou nem desligou o envio
   - `WHATSAPP_TESTE` (opcional) = WhatsApp do administrador com DDD, para o botão "Mandar teste"

Abra o app pelo endereço do Railway: ele já sabe onde está o servidor e só pede a senha uma vez.
Cada conta liga ou desliga o próprio envio automático em Ajustes > WhatsApp e envio automático; o horário só
fica liberado com o envio ligado. `HORARIO_COBRANCA` e `ENVIO_AUTOMATICO` não travam mais a escolha das contas.
4. Settings > Networking > Generate Domain.
5. No app: Ajustes > Nuvem (Railway), cole o endereço e a senha.

## Usuários

O administrador entra com o usuário `admin` (ou o de `ADMIN_USUARIO`) e a senha de `APP_SENHA`. Em Ajustes > Administração ele vê quantos usuários existem, cadastra novos, troca a senha e bloqueia. Cada usuário vê só os próprios clientes.

Cada usuário troca a própria senha em Ajustes > Sua conta > Trocar senha (os outros aparelhos dele precisam entrar de novo). O botão **Sair** fica no topo do app.

### Painel do administrador

Abra `<endereço do Railway>/admin` no computador (ou toque em **Abrir painel do administrador** em Ajustes). Só entra o administrador. O painel mostra:

- **Contas**: todas as contas com situação, WhatsApp, envio automático, clientes, valor na rua, atrasado, recebido no mês, envios de hoje e último acesso. Clique numa conta para ver os clientes, empréstimos, pagamentos e envios dela, trocar a senha ou bloquear.
- **Clientes**: os clientes de todas as contas numa tabela só, com busca e filtro de quem está atrasado.
- **Envios**: as últimas mensagens que o robô mandou, de todas as contas.

As colunas das tabelas ordenam com um clique no título. Os dados se atualizam sozinhos a cada minuto.

## WhatsApp de cada conta

Cada conta (o administrador e cada usuário) tem a própria instância na Evolution e conecta o próprio WhatsApp:
em Ajustes > WhatsApp e envio automático, toque em **Conectar pelo QR Code** e leia o código no celular
(WhatsApp > Aparelhos conectados > Conectar aparelho). A instância é criada sozinha na primeira vez, com o nome
`cashday-<usuário>`. O robô cobra os clientes de cada conta pelo WhatsApp dela, e espera enquanto ele estiver desconectado.

Com o WhatsApp conectado, os botões **Cobrar** e **Cobrar todos** continuam abrindo a mensagem para editar, mas
**Enviar no WhatsApp** manda direto pela Evolution, sem abrir o link do WhatsApp. O cliente cobrado assim não
recebe de novo do robô no mesmo dia.

## Cadastro pelo link

Em Clientes, o botão "Mandar link para o cliente se cadastrar" cria um link de uso único (vale 7 dias), no formato `/c/<código>`. O cliente abre, tira uma foto na hora e preenche nome completo, CPF, nascimento, WhatsApp, CEP e endereço (todos obrigatórios). O cadastro entra direto na conta de quem mandou o link, com a foto em "Fotos e documentos".
