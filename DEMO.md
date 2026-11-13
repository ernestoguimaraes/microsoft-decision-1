# Roteiro da demo - Decision-1 Lab

**Pitch:** "Nao e mais um chatbot. E uma forma de apoiar a triagem: o modelo
estima equipe, urgencia e severidade; as regras do negocio definem o proximo passo."

## Preparar

Execute `.\start-demo.ps1` no PowerShell e abra o endereco exibido.
Use somente chamados ficticios. Se o login estiver configurado, use suas
credenciais existentes; as geradas pelo projeto ficam em `.azure\app-login.txt`.

## 1. Abrir com o problema

Pergunte ao cliente: **"Hoje, como voces decidem quem deve atender um chamado
e quais casos precisam passar na frente?"**

Conecte com a proposta: "Vamos explorar como apoiar essa decisao sem tirar
da operacao o controle das regras."

## 2. Mostrar um caso simples

Cole no campo **Customer support request** e clique em **Run decision**:

> Minha assinatura foi cobrada duas vezes neste mes. Consigo usar o produto
> normalmente e preciso do reembolso da cobranca duplicada.

Pergunte: **"Qual equipe deveria receber este chamado? Existe motivo para
escalonamento urgente?"**

Mostre a distribuicao entre equipes, a probabilidade de urgencia e o indice
de severidade de 0 a 3. Observe o resultado real, sem prometer uma resposta.

## 3. Mudar o impacto no negocio

Substitua o chamado e execute novamente:

> O checkout esta fora do ar para todos os clientes. Nenhum pedido pode ser
> realizado e todas as vendas estao paradas.

Pergunte: **"O que mudou: somente a equipe responsavel ou tambem a prioridade?"**

Mostre como a politica recomenda escalonamento humano quando a probabilidade
de urgencia atinge o limite definido.

## 4. Mostrar controle e revisao humana

Substitua o chamado e execute novamente:

> Nao consigo acessar minha conta para conferir uma cobranca que nao reconheco.
> Nao sei se o problema esta no acesso ou no pagamento.

Pergunte: **"Quando existe ambiguidade, voces preferem sugerir uma equipe ou
pedir revisao humana?"**

Observe as probabilidades e ajuste **Routing threshold** para comparar politicas.
O ajuste reaplica a regra localmente, sem nova chamada ao modelo. A revisao
ocorre quando a probabilidade da equipe fica abaixo do limite; se a urgencia
atingir seu proprio limite, o escalonamento urgente tem precedencia.
Nao prometa que este exemplo sempre resultara em revisao.

## 5. Encerrar com valor e proximo passo

Pergunte: **"Quais indicadores fariam esse piloto valer a pena: tempo de triagem,
reencaminhamentos ou identificacao de casos urgentes?"**

Feche: "O proximo passo seria avaliar esse padrao com uma amostra representativa
e rotulada, em ambiente aprovado, e medir os resultados antes de integrar
ao processo de atendimento."

**Limites da demonstracao:** esta e uma PoC, nao um roteador em producao.
Nenhum chamado e encaminhado de verdade. Os escores sao previsoes, nao garantias;
os exemplos nao comprovam precisao nem economia. Cada execucao de inferencia
tem custo e pode aguardar na fila.
