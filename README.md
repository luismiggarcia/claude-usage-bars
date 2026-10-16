# usage-bars

Um mod para o Claude Code que mostra, numa linha imediatamente acima da caixa do prompt, três barras:

| Barra | O que mede | Detalhe no hover |
| --- | --- | --- |
| **Contexto** | o contexto da sessão atual já ocupado | tokens usados / janela |
| **Sessão** | a janela de uso de 5 horas da conta | quanto falta para repor |
| **Semana** | o limite semanal da conta | quanto falta para repor |

Cada barra tem a sua cor (azul, violeta, verde-água) e passa a vermelho a partir de 85%. No desktop as barras são pílulas finas em SVG; no terminal, blocos de cor.

Os valores de Sessão e Semana chegam com cada resposta da API: numa sessão parada ficam com o último valor que essa sessão viu.

## Instalar

No prompt de uma sessão de terminal:

```
/plugin install usage-bars --marketplace luismiggarcia/claude-usage-bars
```

Numa shell:

```bash
claude plugin install usage-bars --marketplace luismiggarcia/claude-usage-bars
```

Na app desktop, onde `/plugin` não corre: clicar em **+** ao lado da caixa do prompt, depois **Plugins**, **Add marketplace** com `luismiggarcia/claude-usage-bars`, e **Add plugin**.

Instalado no âmbito do utilizador, carrega em todas as sessões novas.

## Desenvolver

```bash
claude plugin validate .
```

```bash
claude plugin test .
```

---

© LG-Systems
