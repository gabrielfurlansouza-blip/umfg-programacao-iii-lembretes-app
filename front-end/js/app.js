"use strict";

// =====================================================================
// CONFIGURAÇÃO
// =====================================================================

// Endereço da API (perfil "https" do launchSettings.json).
// Se a API for executada pelo perfil "http", troque para "http://localhost:5207".
const API_URL = "https://localhost:7063";

// Tempo máximo de espera por uma resposta da API
const TEMPO_LIMITE_MS = 10000;

// A API só ignora um filtro de data quando recebe um "valor neutro":
//  - datas iniciais: DateTime.MinValue (0001-01-01) → a API não aplica o filtro
//  - datas finais: uma data muito distante. A API soma 1 dia à data final para
//    incluir o dia inteiro; com 9999-12-31 isso estouraria o DateTime, por isso 9999-12-30.
// Assim, quando o usuário deixa uma data em branco, todos os registros continuam aparecendo.
const DATA_INICIAL_NEUTRA = "0001-01-01";
const DATA_FINAL_NEUTRA = "9999-12-30";

// Campos aceitos pela API no parâmetro "Ordem" e a direção usada no primeiro clique
const CAMPOS_ORDENACAO = {
    Descricao: { nome: "descrição", direcaoInicial: "ASC" },
    DataCadastro: { nome: "data de cadastro", direcaoInicial: "DESC" },
    DataAtualizacao: { nome: "data de atualização", direcaoInicial: "DESC" }
};

const CHAVE_TEMA = "lembretes:tema";


// =====================================================================
// ESTADO DA TELA
// =====================================================================

const FILTROS_VAZIOS = Object.freeze({
    descricao: "",
    dataCadastroInicial: "",
    dataCadastroFinal: "",
    dataAtualizacaoInicial: "",
    dataAtualizacaoFinal: ""
});

const estado = {
    numeroPagina: 1,
    tamanhoPagina: 10,
    ordem: "DataCadastro",   // padrão da API
    direcao: "DESC",         // padrão da API
    filtros: { ...FILTROS_VAZIOS },
    total: 0,
    idDestacado: null,       // linha que pisca depois de criar/editar
    idParaExcluir: null,
    consultaAtual: null      // AbortController da consulta em andamento
};


// =====================================================================
// ELEMENTOS DA PÁGINA
// =====================================================================

const $ = id => document.getElementById(id);

const elementos = {
    hoje: $("hoje"),
    btnTema: $("btnTema"),
    btnImprimir: $("btnImprimir"),
    btnNovo: $("btnNovo"),

    barraProgresso: $("barraProgresso"),

    detalhesFiltros: $("detalhesFiltros"),
    formFiltros: $("formFiltros"),
    filtroDescricao: $("filtroDescricao"),
    filtroCadastroInicial: $("filtroCadastroInicial"),
    filtroCadastroFinal: $("filtroCadastroFinal"),
    filtroAtualizacaoInicial: $("filtroAtualizacaoInicial"),
    filtroAtualizacaoFinal: $("filtroAtualizacaoFinal"),
    erroCadastro: $("erroCadastro"),
    erroAtualizacao: $("erroAtualizacao"),
    btnLimparFiltros: $("btnLimparFiltros"),

    lista: $("lista"),
    totalRegistros: $("totalRegistros"),
    filtrosAtivos: $("filtrosAtivos"),
    tabela: $("tabela"),
    cabecalhoTabela: $("cabecalhoTabela"),
    listaLembretes: $("listaLembretes"),
    estadoLista: $("estadoLista"),

    paginacao: $("paginacao"),
    resumoPaginacao: $("resumoPaginacao"),
    listaPaginas: $("listaPaginas"),
    btnAnterior: $("btnAnterior"),
    btnProximo: $("btnProximo"),
    tamanhoPagina: $("tamanhoPagina"),

    formulario: $("formulario"),
    formLembrete: $("formLembrete"),
    tituloFormulario: $("tituloFormulario"),
    lembreteId: $("lembreteId"),
    descricao: $("descricao"),
    erroDescricao: $("erroDescricao"),
    contadorDescricao: $("contadorDescricao"),
    infoLembrete: $("infoLembrete"),
    btnCancelar: $("btnCancelar"),
    btnSalvar: $("btnSalvar"),

    confirmacao: $("confirmacao"),
    textoConfirmacao: $("textoConfirmacao"),
    btnManter: $("btnManter"),
    btnConfirmarExclusao: $("btnConfirmarExclusao"),

    toasts: $("toasts")
};


// =====================================================================
// COMUNICAÇÃO COM A API
// Todas as requisições passam por chamarApi(): ela monta a URL, define
// headers e corpo, aplica tempo limite, registra tudo no console (para a
// Etapa 7) e transforma falhas em mensagens compreensíveis.
// =====================================================================

class ErroApi extends Error {
    constructor(mensagem, { tipo = "http", status = 0 } = {}) {
        super(mensagem);
        this.name = "ErroApi";
        this.tipo = tipo;       // "http" | "rede" | "tempo" | "cancelada"
        this.status = status;   // código HTTP (0 quando nem houve resposta)
    }
}

async function chamarApi(caminho, { metodo = "GET", corpo, params, sinal, formato = "json" } = {}) {
    const url = new URL(caminho, API_URL);

    if (params) {
        url.search = params.toString();
    }

    const headers = {
        Accept: formato === "pdf" ? "application/pdf" : "application/json"
    };

    const opcoes = { method: metodo, headers };

    if (corpo !== undefined) {
        headers["Content-Type"] = "application/json";
        opcoes.body = JSON.stringify(corpo);
    }

    // AbortController: cancela por tempo limite ou quando outra consulta substitui esta
    const controlador = new AbortController();
    const temporizador = setTimeout(() => controlador.abort("tempo"), TEMPO_LIMITE_MS);

    if (sinal) {
        sinal.addEventListener("abort", () => controlador.abort("cancelada"), { once: true });
    }

    opcoes.signal = controlador.signal;

    const inicio = performance.now();
    let response;

    try {
        response = await fetch(url, opcoes);
    } catch (erro) {
        clearTimeout(temporizador);

        if (controlador.signal.aborted && controlador.signal.reason === "cancelada") {
            throw new ErroApi("Consulta substituída por outra mais recente.", { tipo: "cancelada" });
        }

        if (controlador.signal.aborted) {
            console.warn(`[API] ${metodo} ${url.href} → sem resposta em ${TEMPO_LIMITE_MS / 1000}s`);
            throw new ErroApi(`A API não respondeu em ${TEMPO_LIMITE_MS / 1000} segundos.`, { tipo: "tempo" });
        }

        // fetch só lança erro (TypeError) quando não há resposta HTTP:
        // API desligada, certificado HTTPS não aceito, bloqueio de CORS, sem rede...
        console.error(`[API] ${metodo} ${url.href} → falha de comunicação`, erro);
        throw new ErroApi(`Sem conexão com a API em ${API_URL}.`, { tipo: "rede" });
    }

    clearTimeout(temporizador);

    const corpoResposta = await lerCorpoResposta(response, formato);
    const duracao = Math.round(performance.now() - inicio);

    registrarNoConsole({ metodo, url, headers, corpo, response, corpoResposta, duracao });

    if (!response.ok) {
        throw new ErroApi(mensagemPorStatus(response.status, corpoResposta), { status: response.status });
    }

    return corpoResposta;
}

async function lerCorpoResposta(response, formato) {
    if (response.status === 204) {
        return null;
    }

    if (formato === "pdf" && response.ok) {
        return response.blob();
    }

    const texto = await response.text();

    if (!texto) {
        return null;
    }

    try {
        return JSON.parse(texto);
    } catch {
        return texto;
    }
}

function mensagemPorStatus(status, corpo) {
    // Results.BadRequest("texto") da API devolve o texto como JSON (string)
    const detalheApi = typeof corpo === "string" && corpo.length <= 160 && !corpo.trimStart().startsWith("<")
        ? ` ${corpo}`
        : "";

    switch (status) {
        case 400:
            return `A API recusou os dados enviados (400).${detalheApi}`;
        case 404:
            return "Lembrete não encontrado (404). Ele pode ter sido excluído.";
        case 405:
            return "A API não aceita este método nesta rota (405).";
        case 415:
            return "A API não entendeu o formato do corpo enviado (415).";
        default:
            return status >= 500
                ? `A API encontrou um erro interno (${status}). Veja o console da API.`
                : `A API respondeu com o código ${status}.${detalheApi}`;
    }
}

// Etapa 7: cada requisição aparece no console do navegador como um grupo
// com método, URL, query string, headers, corpo enviado, status e resposta.
function registrarNoConsole({ metodo, url, headers, corpo, response, corpoResposta, duracao }) {
    const cor = response.ok ? "#1C7C51" : "#C02F3D";

    console.groupCollapsed(
        `%c${metodo}%c ${url.pathname} %c${response.status}%c ${duracao} ms`,
        "color:#2446C9;font-weight:bold", "color:inherit",
        `color:${cor};font-weight:bold`, "color:gray"
    );
    console.log("URL:", url.href);

    if (url.search) {
        console.log("Query string:");
        console.table(Object.fromEntries(url.searchParams));
    }

    console.log("Headers enviados:", headers);

    if (corpo !== undefined) {
        console.log("Corpo enviado:", corpo);
    }

    console.log("Status:", response.status, response.statusText);
    console.log("Headers recebidos:", Object.fromEntries(response.headers.entries()));
    console.log("Resposta:", corpoResposta);
    console.groupEnd();
}


// =====================================================================
// OPERAÇÕES DA API
// =====================================================================

// GET /lembretes/filtro — consulta com filtros, paginação e ordenação
async function carregarLembretes() {
    estado.consultaAtual?.abort();

    const controlador = new AbortController();
    estado.consultaAtual = controlador;

    definirCarregando(true);

    try {
        const resultado = await chamarApi("/lembretes/filtro", {
            params: montarParametros(),
            sinal: controlador.signal
        });

        const lembretes = Array.isArray(resultado?.lembretes) ? resultado.lembretes : [];
        const total = Number(resultado?.total) || 0;
        const ultimaPagina = Math.max(1, Math.ceil(total / estado.tamanhoPagina));

        // a página atual deixou de existir (ex.: excluiu o último item da última página)
        if (lembretes.length === 0 && total > 0 && estado.numeroPagina > ultimaPagina) {
            estado.numeroPagina = ultimaPagina;
            return carregarLembretes();
        }

        estado.total = total;

        renderizarLembretes(lembretes);
        renderizarResumo();
        renderizarPaginacao();
    } catch (erro) {
        if (erro.tipo === "cancelada") {
            return;
        }

        estado.total = 0;

        renderizarErroNaLista(erro);
        renderizarPaginacao();
        mostrarToast(erro.message, "erro");
    } finally {
        if (estado.consultaAtual === controlador) {
            estado.consultaAtual = null;
            definirCarregando(false);
        }
    }
}

// GET /lembretes/{id} — busca um lembrete para edição
async function buscarLembrete(id) {
    return chamarApi(`/lembretes/${encodeURIComponent(id)}`);
}

// POST /lembretes — cadastra
async function criarLembrete(descricao) {
    return chamarApi("/lembretes", { metodo: "POST", corpo: { descricao } });
}

// PUT /lembretes/{id} — atualiza a descrição
async function atualizarLembrete(id, descricao) {
    return chamarApi(`/lembretes/${encodeURIComponent(id)}`, { metodo: "PUT", corpo: { descricao } });
}

// DELETE /lembretes/{id} — exclui (na API é exclusão lógica: IsAtivo = false)
async function excluirLembrete(id) {
    return chamarApi(`/lembretes/${encodeURIComponent(id)}`, { metodo: "DELETE" });
}

// GET /lembretes/imprimir — baixa o PDF com os filtros e a ordenação atuais
async function baixarPdf() {
    if (estado.total === 0) {
        mostrarToast("Não há lembretes para o relatório com os filtros atuais.", "aviso");
        return;
    }

    // o relatório traz todos os lembretes filtrados (não só a página visível)
    const params = montarParametros({ numeroPagina: 1, tamanhoPagina: estado.total });
    const textoOriginal = definirTextoBotao(elementos.btnImprimir, "Gerando PDF…");

    elementos.btnImprimir.disabled = true;

    try {
        const pdf = await chamarApi("/lembretes/imprimir", { params, formato: "pdf" });
        const url = URL.createObjectURL(pdf);
        const link = document.createElement("a");

        link.href = url;
        link.download = "relatorio-lembretes.pdf";
        document.body.appendChild(link);
        link.click();
        link.remove();

        setTimeout(() => URL.revokeObjectURL(url), 10000);

        mostrarToast(`Relatório PDF com ${formatarQuantidade(estado.total)} baixado.`, "sucesso");
    } catch (erro) {
        mostrarToast(`Não foi possível gerar o PDF. ${erro.message}`, "erro");
    } finally {
        elementos.btnImprimir.disabled = false;
        definirTextoBotao(elementos.btnImprimir, textoOriginal);
    }
}


// =====================================================================
// PARÂMETROS DA CONSULTA (query string)
// =====================================================================

function montarParametros({ numeroPagina = estado.numeroPagina, tamanhoPagina = estado.tamanhoPagina } = {}) {
    const f = estado.filtros;

    return new URLSearchParams({
        NumeroPagina: numeroPagina,
        TamanhoPagina: tamanhoPagina,
        Ordem: estado.ordem,
        Direcao: estado.direcao,
        Descricao: f.descricao,
        DataCadastroInicial: f.dataCadastroInicial || DATA_INICIAL_NEUTRA,
        DataCadastroFinal: f.dataCadastroFinal || DATA_FINAL_NEUTRA,
        DataAtualizacaoInicial: f.dataAtualizacaoInicial || DATA_INICIAL_NEUTRA,
        DataAtualizacaoFinal: f.dataAtualizacaoFinal || DATA_FINAL_NEUTRA
    });
}

function temFiltrosAtivos() {
    return Object.values(estado.filtros).some(valor => valor !== "");
}


// =====================================================================
// RENDERIZAÇÃO DA LISTA
// =====================================================================

function renderizarLembretes(lembretes) {
    elementos.listaLembretes.replaceChildren();

    if (lembretes.length === 0) {
        renderizarListaVazia();
        return;
    }

    elementos.estadoLista.hidden = true;
    elementos.tabela.hidden = false;

    const linhas = lembretes.map(criarLinha);
    elementos.listaLembretes.append(...linhas);

    // pisca a linha recém-criada/editada, se ela estiver na página atual
    if (estado.idDestacado) {
        const linha = linhas.find(tr => tr.dataset.id === estado.idDestacado);
        linha?.classList.add("destaque");
        estado.idDestacado = null;
    }
}

// Cria a linha com DOM (textContent), nunca com innerHTML: assim um lembrete
// com "<script>" na descrição aparece como texto e não é executado (evita XSS).
function criarLinha(lembrete) {
    const tr = document.createElement("tr");
    tr.dataset.id = lembrete.id;

    const tdDescricao = criarCelula("descricao");
    tdDescricao.append(destacarTermo(lembrete.descricao ?? "", estado.filtros.descricao));

    const tdCadastro = criarCelulaData(lembrete.dataCadastro, "Cadastro", "data-cadastro");
    const tdAtualizacao = criarCelulaData(lembrete.dataAtualizacao, "Atualização", "data-atualizacao");

    const tdStatus = criarCelula("status");
    const carimbo = document.createElement("span");
    carimbo.className = lembrete.isAtivo ? "carimbo" : "carimbo carimbo--inativo";
    carimbo.textContent = lembrete.isAtivo ? "Ativo" : "Inativo";
    tdStatus.append(carimbo);

    const tdAcoes = criarCelula("acoes-celula");
    const acoes = document.createElement("div");
    acoes.className = "acoes";
    acoes.append(
        criarBotaoAcao("editar", "Editar", "i-lapis", lembrete),
        criarBotaoAcao("excluir", "Excluir", "i-lixeira", lembrete)
    );
    tdAcoes.append(acoes);

    tr.append(tdDescricao, tdCadastro, tdAtualizacao, tdStatus, tdAcoes);

    return tr;
}

function criarCelula(classe) {
    const td = document.createElement("td");
    td.className = classe;
    return td;
}

function criarCelulaData(valor, rotulo, classe) {
    const td = criarCelula(`data ${classe}`);
    td.dataset.rotulo = rotulo;

    const data = converterData(valor);

    if (!data) {
        td.textContent = "—";
        return td;
    }

    const time = document.createElement("time");
    time.dateTime = data.toISOString();
    time.textContent = formatarData(data);
    time.title = data.toLocaleString("pt-BR", { dateStyle: "full", timeStyle: "medium" });

    const relativa = document.createElement("span");
    relativa.className = "data__relativa";
    relativa.textContent = tempoRelativo(data);

    td.append(time, relativa);
    return td;
}

function criarBotaoAcao(acao, texto, icone, lembrete) {
    const botao = document.createElement("button");
    botao.type = "button";
    botao.className = `btn-acao btn-acao--${acao}`;
    botao.dataset.acao = acao;
    botao.dataset.id = lembrete.id;
    botao.setAttribute("aria-label", `${texto}: ${resumirTexto(lembrete.descricao, 60)}`);
    botao.append(criarIcone(icone), document.createTextNode(texto));
    return botao;
}

function criarIcone(id, classe = "icone") {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", classe);
    svg.setAttribute("aria-hidden", "true");

    const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    use.setAttribute("href", `#${id}`);

    svg.append(use);
    return svg;
}

function renderizarListaVazia() {
    elementos.tabela.hidden = false;

    if (temFiltrosAtivos()) {
        mostrarEstado({
            icone: "i-funil",
            titulo: "Nenhum lembrete corresponde aos filtros",
            texto: "Revise a descrição ou o período informado, ou limpe os filtros para ver tudo.",
            acoes: [{ texto: "Limpar filtros", classe: "btn btn--primario", aoClicar: limparFiltros }]
        });
        return;
    }

    mostrarEstado({
        icone: "i-caderno",
        titulo: "Nenhum lembrete cadastrado",
        texto: "Crie o primeiro lembrete e ele aparece aqui.",
        acoes: [{ texto: "Novo lembrete", classe: "btn btn--primario", icone: "i-mais", aoClicar: abrirFormularioNovo }]
    });
}

function renderizarErroNaLista(erro) {
    elementos.listaLembretes.replaceChildren();

    const dicaRede = `Confira se a API está em execução (perfil https) e se o navegador aceitou o certificado
        de desenvolvimento: abra o endereço da API em uma nova aba, aceite o aviso e tente novamente.`;

    mostrarEstado({
        erro: true,
        icone: erro.tipo === "rede" || erro.tipo === "tempo" ? "i-desconectado" : "i-alerta",
        titulo: "Não foi possível carregar os lembretes",
        texto: erro.tipo === "rede" ? `${erro.message} ${dicaRede}` : erro.message,
        acoes: [
            { texto: "Tentar novamente", classe: "btn btn--primario", icone: "i-recarregar", aoClicar: carregarLembretes },
            ...(erro.tipo === "rede" ? [{ texto: "Abrir a API em nova aba", classe: "btn btn--texto", link: `${API_URL}/lembretes` }] : [])
        ]
    });

    elementos.totalRegistros.textContent = "Sem dados: a consulta falhou.";
}

function mostrarEstado({ icone, titulo, texto, acoes = [], erro = false }) {
    const caixa = elementos.estadoLista;
    caixa.replaceChildren();
    caixa.className = erro ? "estado estado--erro" : "estado";
    caixa.setAttribute("role", erro ? "alert" : "status");

    const elTitulo = document.createElement("p");
    elTitulo.className = "estado__titulo";
    elTitulo.textContent = titulo;

    const elTexto = document.createElement("p");
    elTexto.className = "estado__texto";
    elTexto.textContent = texto.replace(/\s+/g, " ");

    const elAcoes = document.createElement("div");
    elAcoes.className = "estado__acoes";

    acoes.forEach(acao => {
        const el = document.createElement(acao.link ? "a" : "button");
        el.className = acao.classe;

        if (acao.link) {
            el.href = acao.link;
            el.target = "_blank";
            el.rel = "noopener";
        } else {
            el.type = "button";
            el.addEventListener("click", acao.aoClicar);
        }

        if (acao.icone) {
            el.append(criarIcone(acao.icone));
        }

        el.append(document.createTextNode(acao.texto));
        elAcoes.append(el);
    });

    caixa.append(criarIcone(icone, "icone estado__icone"), elTitulo, elTexto, elAcoes);
    caixa.hidden = false;
}

function renderizarResumo() {
    const { nome } = CAMPOS_ORDENACAO[estado.ordem];
    const sentido = estado.ordem === "Descricao"
        ? (estado.direcao === "ASC" ? "de A a Z" : "de Z a A")
        : (estado.direcao === "DESC" ? "mais recentes primeiro" : "mais antigos primeiro");

    elementos.totalRegistros.replaceChildren();

    const quantidade = document.createElement("strong");
    quantidade.textContent = formatarQuantidade(estado.total);

    elementos.totalRegistros.append(
        quantidade,
        document.createTextNode(estado.total > 0 ? `, ordenados por ${nome} (${sentido})` : "")
    );
}

function renderizarCabecalhoOrdenacao() {
    elementos.cabecalhoTabela.querySelectorAll("th[data-campo]").forEach(th => {
        const ativo = th.dataset.campo === estado.ordem;
        const botao = th.querySelector("button");
        const { nome } = CAMPOS_ORDENACAO[th.dataset.campo];

        th.setAttribute("aria-sort", ativo ? (estado.direcao === "ASC" ? "ascending" : "descending") : "none");

        const proximaDirecao = ativo
            ? (estado.direcao === "ASC" ? "decrescente" : "crescente")
            : (CAMPOS_ORDENACAO[th.dataset.campo].direcaoInicial === "ASC" ? "crescente" : "decrescente");

        botao.title = `Ordenar por ${nome} em ordem ${proximaDirecao}`;
    });
}

function renderizarPaginacao() {
    const totalPaginas = Math.max(1, Math.ceil(estado.total / estado.tamanhoPagina));
    const inicio = estado.total === 0 ? 0 : (estado.numeroPagina - 1) * estado.tamanhoPagina + 1;
    const fim = Math.min(estado.numeroPagina * estado.tamanhoPagina, estado.total);

    elementos.resumoPaginacao.textContent = estado.total === 0
        ? "Nenhum registro para exibir"
        : `Mostrando ${inicio}–${fim} de ${estado.total}`;

    elementos.btnAnterior.disabled = estado.numeroPagina <= 1;
    elementos.btnProximo.disabled = estado.numeroPagina >= totalPaginas;

    elementos.listaPaginas.replaceChildren();

    if (estado.total === 0) {
        return;
    }

    paginasVisiveis(estado.numeroPagina, totalPaginas).forEach(item => {
        const li = document.createElement("li");

        if (item === "…") {
            li.className = "reticencias";
            li.textContent = "…";
            li.setAttribute("aria-hidden", "true");
        } else {
            const botao = document.createElement("button");
            botao.type = "button";
            botao.className = "pagina";
            botao.textContent = item;
            botao.dataset.pagina = item;
            botao.setAttribute("aria-label", `Página ${item}`);

            if (item === estado.numeroPagina) {
                botao.setAttribute("aria-current", "page");
            }

            li.append(botao);
        }

        elementos.listaPaginas.append(li);
    });
}

// Ex.: atual = 6 de 12 → [1, "…", 5, 6, 7, "…", 12]
function paginasVisiveis(atual, total) {
    if (total <= 7) {
        return Array.from({ length: total }, (_, i) => i + 1);
    }

    const paginas = new Set([1, total, atual - 1, atual, atual + 1]);

    if (atual <= 3) [2, 3, 4].forEach(p => paginas.add(p));
    if (atual >= total - 2) [total - 3, total - 2, total - 1].forEach(p => paginas.add(p));

    const ordenadas = [...paginas].filter(p => p >= 1 && p <= total).sort((a, b) => a - b);
    const resultado = [];

    ordenadas.forEach((pagina, i) => {
        if (i > 0 && pagina - ordenadas[i - 1] > 1) {
            resultado.push(pagina - ordenadas[i - 1] === 2 ? pagina - 1 : "…");
        }
        resultado.push(pagina);
    });

    return resultado;
}

function definirCarregando(carregando) {
    elementos.barraProgresso.hidden = !carregando;
    elementos.tabela.setAttribute("aria-busy", String(carregando));
    elementos.listaLembretes.classList.toggle("carregando", carregando && elementos.listaLembretes.children.length > 0);

    // primeira consulta: mostra linhas "fantasma" no lugar da tabela vazia
    if (carregando && elementos.listaLembretes.children.length === 0) {
        elementos.estadoLista.hidden = true;
        elementos.listaLembretes.append(...criarLinhasEsqueleto(Math.min(estado.tamanhoPagina, 5)));
    }
}

function criarLinhasEsqueleto(quantidade) {
    return Array.from({ length: quantidade }, (_, i) => {
        const tr = document.createElement("tr");
        tr.setAttribute("aria-hidden", "true");

        ["descricao", "data data-cadastro", "data data-atualizacao", "status", "acoes-celula"].forEach((classe, coluna) => {
            const td = criarCelula(classe);
            const barra = document.createElement("span");
            barra.className = "esqueleto";
            barra.style.width = coluna === 0 ? `${55 + ((i * 17) % 40)}%` : "70%";
            td.append(barra);
            tr.append(td);
        });

        return tr;
    });
}


// =====================================================================
// FILTROS
// =====================================================================

function lerFiltrosDoFormulario() {
    return {
        descricao: elementos.filtroDescricao.value.trim(),
        dataCadastroInicial: elementos.filtroCadastroInicial.value,
        dataCadastroFinal: elementos.filtroCadastroFinal.value,
        dataAtualizacaoInicial: elementos.filtroAtualizacaoInicial.value,
        dataAtualizacaoFinal: elementos.filtroAtualizacaoFinal.value
    };
}

function validarPeriodo(campoInicial, campoFinal, elementoErro, nomePeriodo) {
    let mensagem = "";

    if (!campoInicial.checkValidity() || !campoFinal.checkValidity()) {
        mensagem = `Informe uma data de ${nomePeriodo} completa e válida.`;
    } else if (campoInicial.value && campoFinal.value && campoInicial.value > campoFinal.value) {
        mensagem = `A data final de ${nomePeriodo} não pode ser anterior à inicial.`;
    }

    const valido = mensagem === "";

    elementoErro.textContent = mensagem;
    elementoErro.hidden = valido;
    campoInicial.setAttribute("aria-invalid", String(!valido));
    campoFinal.setAttribute("aria-invalid", String(!valido));

    return valido;
}

function validarFiltros() {
    const cadastroOk = validarPeriodo(
        elementos.filtroCadastroInicial, elementos.filtroCadastroFinal, elementos.erroCadastro, "cadastro");
    const atualizacaoOk = validarPeriodo(
        elementos.filtroAtualizacaoInicial, elementos.filtroAtualizacaoFinal, elementos.erroAtualizacao, "atualização");

    return cadastroOk && atualizacaoOk;
}

function aplicarFiltros() {
    if (!validarFiltros()) {
        mostrarToast("Corrija o período destacado antes de filtrar.", "aviso");
        elementos.formFiltros.querySelector('[aria-invalid="true"]')?.focus();
        return;
    }

    estado.filtros = lerFiltrosDoFormulario();
    estado.numeroPagina = 1;

    renderizarChipsFiltros();
    carregarLembretes();
}

function limparFiltros() {
    elementos.formFiltros.reset();
    validarFiltros();

    estado.filtros = { ...FILTROS_VAZIOS };
    estado.numeroPagina = 1;

    renderizarChipsFiltros();
    carregarLembretes();
}

// remove um único filtro clicando no "x" do chip
function removerFiltro(chave) {
    const campos = {
        descricao: [elementos.filtroDescricao],
        cadastro: [elementos.filtroCadastroInicial, elementos.filtroCadastroFinal],
        atualizacao: [elementos.filtroAtualizacaoInicial, elementos.filtroAtualizacaoFinal]
    };

    campos[chave].forEach(campo => { campo.value = ""; });
    validarFiltros();

    estado.filtros = lerFiltrosDoFormulario();
    estado.numeroPagina = 1;

    renderizarChipsFiltros();
    carregarLembretes();
}

function renderizarChipsFiltros() {
    const f = estado.filtros;
    const chips = [];

    if (f.descricao) {
        chips.push({ chave: "descricao", rotulo: "Descrição contém", valor: `“${resumirTexto(f.descricao, 30)}”` });
    }

    const periodo = (inicial, final) => {
        if (inicial && final) return `${formatarDiaIso(inicial)} a ${formatarDiaIso(final)}`;
        if (inicial) return `a partir de ${formatarDiaIso(inicial)}`;
        return `até ${formatarDiaIso(final)}`;
    };

    if (f.dataCadastroInicial || f.dataCadastroFinal) {
        chips.push({ chave: "cadastro", rotulo: "Cadastro", valor: periodo(f.dataCadastroInicial, f.dataCadastroFinal) });
    }

    if (f.dataAtualizacaoInicial || f.dataAtualizacaoFinal) {
        chips.push({ chave: "atualizacao", rotulo: "Atualização", valor: periodo(f.dataAtualizacaoInicial, f.dataAtualizacaoFinal) });
    }

    elementos.filtrosAtivos.replaceChildren(...chips.map(chip => {
        const span = document.createElement("span");
        span.className = "chip";

        const valor = document.createElement("strong");
        valor.textContent = chip.valor;

        const remover = document.createElement("button");
        remover.type = "button";
        remover.setAttribute("aria-label", `Remover filtro: ${chip.rotulo} ${chip.valor}`);
        remover.append(criarIcone("i-fechar"));
        remover.addEventListener("click", () => removerFiltro(chip.chave));

        span.append(document.createTextNode(`${chip.rotulo} `), valor, remover);
        return span;
    }));
}


// =====================================================================
// FORMULÁRIO (cadastro e edição)
// =====================================================================

function abrirFormularioNovo() {
    elementos.formLembrete.reset();
    elementos.lembreteId.value = "";
    elementos.tituloFormulario.textContent = "Novo lembrete";
    definirTextoBotao(elementos.btnSalvar, "Salvar lembrete");
    elementos.infoLembrete.hidden = true;

    limparErroDescricao();
    atualizarContador();

    elementos.formulario.showModal();
    elementos.descricao.focus();
}

async function abrirFormularioEdicao(id, botao) {
    botao.disabled = true;

    try {
        const lembrete = await buscarLembrete(id);

        elementos.formLembrete.reset();
        elementos.lembreteId.value = lembrete.id;
        elementos.descricao.value = lembrete.descricao;
        elementos.tituloFormulario.textContent = "Editar lembrete";
        definirTextoBotao(elementos.btnSalvar, "Salvar alterações");

        preencherInfoLembrete(lembrete);
        limparErroDescricao();
        atualizarContador();

        elementos.formulario.showModal();
        elementos.descricao.focus();
        elementos.descricao.setSelectionRange(elementos.descricao.value.length, elementos.descricao.value.length);
    } catch (erro) {
        if (erro.status === 404) {
            mostrarToast("Este lembrete não existe mais. A lista foi atualizada.", "aviso");
            carregarLembretes();
        } else {
            mostrarToast(`Não foi possível abrir o lembrete. ${erro.message}`, "erro");
        }
    } finally {
        botao.disabled = false;
    }
}

function preencherInfoLembrete(lembrete) {
    const itens = [
        ["Código", lembrete.id],
        ["Cadastro", formatarData(converterData(lembrete.dataCadastro))],
        ["Atualização", formatarData(converterData(lembrete.dataAtualizacao))]
    ];

    elementos.infoLembrete.replaceChildren(...itens.flatMap(([rotulo, valor]) => {
        const dt = document.createElement("dt");
        dt.textContent = rotulo;

        const dd = document.createElement("dd");
        dd.textContent = valor;

        return [dt, dd];
    }));

    elementos.infoLembrete.hidden = false;
}

function fecharFormulario() {
    elementos.formulario.close();
}

async function salvarFormulario(event) {
    event.preventDefault();

    const descricao = elementos.descricao.value.trim();
    const id = elementos.lembreteId.value;

    if (!descricao) {
        mostrarErroDescricao("Escreva a descrição do lembrete. Este campo é obrigatório.");
        mostrarToast("Preencha a descrição antes de salvar.", "aviso");
        elementos.descricao.focus();
        return;
    }

    definirSalvando(true);

    try {
        if (id) {
            const atualizado = await atualizarLembrete(id, descricao);
            estado.idDestacado = atualizado?.id ?? id;
            mostrarToast("Lembrete atualizado.", "sucesso");
        } else {
            const criado = await criarLembrete(descricao);
            estado.idDestacado = criado?.id ?? null;
            estado.numeroPagina = 1;
            mostrarToast("Lembrete criado.", "sucesso");
        }

        definirSalvando(false);
        fecharFormulario();
        await carregarLembretes();
    } catch (erro) {
        if (erro.status === 404) {
            fecharFormulario();
            mostrarToast("Este lembrete foi excluído antes de ser salvo. A lista foi atualizada.", "aviso");
            carregarLembretes();
            return;
        }

        // o bilhete continua aberto para o texto digitado não se perder
        mostrarToast(`${id ? "Não foi possível atualizar" : "Não foi possível criar"} o lembrete. ${erro.message}`, "erro");
    } finally {
        definirSalvando(false);
    }
}

function definirSalvando(salvando) {
    elementos.formulario.dataset.salvando = String(salvando);
    elementos.btnSalvar.disabled = salvando;
    elementos.btnCancelar.disabled = salvando;
    elementos.descricao.readOnly = salvando;

    if (salvando) {
        elementos.btnSalvar.dataset.textoOriginal = elementos.btnSalvar.querySelector("span").textContent;
        definirTextoBotao(elementos.btnSalvar, "Salvando…");
    } else if (elementos.btnSalvar.dataset.textoOriginal) {
        definirTextoBotao(elementos.btnSalvar, elementos.btnSalvar.dataset.textoOriginal);
        delete elementos.btnSalvar.dataset.textoOriginal;
    }
}

function mostrarErroDescricao(mensagem) {
    elementos.erroDescricao.textContent = mensagem;
    elementos.erroDescricao.hidden = false;
    elementos.descricao.setAttribute("aria-invalid", "true");
}

function limparErroDescricao() {
    elementos.erroDescricao.hidden = true;
    elementos.descricao.removeAttribute("aria-invalid");
}

function atualizarContador() {
    const tamanho = elementos.descricao.value.length;
    const limite = Number(elementos.descricao.maxLength) || 500;

    elementos.contadorDescricao.textContent = `${tamanho}/${limite}`;
    elementos.contadorDescricao.classList.toggle("contador--limite", tamanho >= limite * 0.9);
}


// =====================================================================
// EXCLUSÃO (com confirmação)
// =====================================================================

function pedirConfirmacaoExclusao(id) {
    const linha = elementos.listaLembretes.querySelector(`tr[data-id="${CSS.escape(id)}"]`);

    estado.idParaExcluir = id;
    elementos.textoConfirmacao.textContent = linha?.querySelector(".descricao")?.textContent ?? "";

    elementos.confirmacao.showModal();
    elementos.btnManter.focus(); // foco na opção segura
}

async function confirmarExclusao() {
    const id = estado.idParaExcluir;

    if (!id) {
        return;
    }

    elementos.btnConfirmarExclusao.disabled = true;
    elementos.btnManter.disabled = true;

    try {
        await excluirLembrete(id);
        elementos.confirmacao.close();
        mostrarToast("Lembrete excluído.", "sucesso");
        await carregarLembretes();
    } catch (erro) {
        elementos.confirmacao.close();

        if (erro.status === 404) {
            mostrarToast("Este lembrete já tinha sido excluído. A lista foi atualizada.", "aviso");
            carregarLembretes();
        } else {
            mostrarToast(`Não foi possível excluir o lembrete. ${erro.message}`, "erro");
        }
    } finally {
        estado.idParaExcluir = null;
        elementos.btnConfirmarExclusao.disabled = false;
        elementos.btnManter.disabled = false;
    }
}


// =====================================================================
// AVISOS (toasts)
// =====================================================================

const ICONES_TOAST = { sucesso: "i-ok", erro: "i-alerta", aviso: "i-alerta", info: "i-info" };

function mostrarToast(mensagem, tipo = "info") {
    const duracao = tipo === "erro" ? 8000 : 4500;

    const toast = document.createElement("div");
    toast.className = `toast toast--${tipo}`;
    toast.setAttribute("role", tipo === "erro" ? "alert" : "status");

    const texto = document.createElement("p");
    texto.textContent = mensagem;

    const fechar = document.createElement("button");
    fechar.type = "button";
    fechar.className = "toast__fechar";
    fechar.setAttribute("aria-label", "Fechar aviso");
    fechar.append(criarIcone("i-fechar"));

    toast.append(criarIcone(ICONES_TOAST[tipo] ?? "i-info"), texto, fechar);
    elementos.toasts.append(toast);

    // no máximo 4 avisos na tela
    while (elementos.toasts.children.length > 4) {
        elementos.toasts.firstElementChild.remove();
    }

    let removido = false;
    const remover = () => {
        if (removido) return;
        removido = true;
        toast.classList.add("toast--saindo");
        setTimeout(() => toast.remove(), 220);
    };

    fechar.addEventListener("click", remover);
    setTimeout(remover, duracao);
}


// =====================================================================
// TEMA (caderno / lousa)
// =====================================================================

function aplicarTema(tema, salvar = false) {
    document.documentElement.dataset.tema = tema;

    const lousa = tema === "lousa";
    definirTextoBotao(elementos.btnTema, lousa ? "Modo caderno" : "Modo lousa");
    document.querySelector('meta[name="theme-color"]').content = lousa ? "#2E231C" : "#1F3FA6";

    if (!salvar) {
        return;
    }

    try {
        localStorage.setItem(CHAVE_TEMA, tema);
    } catch {
        // navegação privada ou armazenamento bloqueado: o tema só não fica salvo
    }
}


// =====================================================================
// UTILITÁRIOS
// =====================================================================

// A API devolve datas sem fuso (ex.: "2026-11-11T20:23:05.1234567"), que o
// JavaScript interpreta como horário local. Os dígitos além dos milissegundos
// são cortados porque nem todo navegador aceita mais de 3 casas decimais.
function converterData(valor) {
    if (!valor) {
        return null;
    }

    const data = new Date(String(valor).replace(/(\.\d{3})\d+/, "$1"));
    return Number.isNaN(data.getTime()) ? null : data;
}

const formatoDia = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" });
const formatoHora = new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit" });
const formatoRelativo = new Intl.RelativeTimeFormat("pt-BR", { numeric: "auto" });

function formatarData(data) {
    return data ? `${formatoDia.format(data)} às ${formatoHora.format(data)}` : "—";
}

// "2026-11-05" → "05/11/2026" (sem passar por Date, para não sofrer com fuso)
function formatarDiaIso(valor) {
    const [ano, mes, dia] = valor.split("-");
    return `${dia}/${mes}/${ano}`;
}

function tempoRelativo(data) {
    const segundos = Math.round((data.getTime() - Date.now()) / 1000);
    const unidades = [
        ["year", 31536000], ["month", 2592000], ["week", 604800],
        ["day", 86400], ["hour", 3600], ["minute", 60]
    ];

    for (const [unidade, tamanho] of unidades) {
        if (Math.abs(segundos) >= tamanho) {
            return formatoRelativo.format(Math.round(segundos / tamanho), unidade);
        }
    }

    return "agora mesmo";
}

function formatarQuantidade(total) {
    return `${total} ${total === 1 ? "lembrete" : "lembretes"}`;
}

function resumirTexto(texto, limite) {
    const limpo = String(texto ?? "").replace(/\s+/g, " ").trim();
    return limpo.length > limite ? `${limpo.slice(0, limite - 1)}…` : limpo;
}

function definirTextoBotao(botao, texto) {
    const span = botao.querySelector("span");
    const anterior = span.textContent;
    span.textContent = texto;
    return anterior;
}

// Grifa o termo pesquisado ignorando maiúsculas e acentos, como o LIKE do
// MySQL faz ("reuniao" encontra "Reunião"). Devolve nós de texto + <mark>.
function destacarTermo(texto, termo) {
    const fragmento = document.createDocumentFragment();

    if (!termo) {
        fragmento.append(texto);
        return fragmento;
    }

    const normalizar = valor => valor.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

    // texto normalizado + mapa de cada caractere normalizado para a posição original
    let normalizado = "";
    const posicoes = [];

    for (let i = 0; i < texto.length; i++) {
        const parte = normalizar(texto[i]);
        normalizado += parte;
        for (let j = 0; j < parte.length; j++) posicoes.push(i);
    }

    const busca = normalizar(termo);
    let cursor = 0;
    let inicioBusca = 0;
    let indice;

    while (busca && (indice = normalizado.indexOf(busca, inicioBusca)) !== -1) {
        const inicio = posicoes[indice];
        const fim = posicoes[indice + busca.length - 1] + 1;

        fragmento.append(texto.slice(cursor, inicio));

        const mark = document.createElement("mark");
        mark.textContent = texto.slice(inicio, fim);
        fragmento.append(mark);

        cursor = fim;
        inicioBusca = indice + busca.length;
    }

    fragmento.append(texto.slice(cursor));
    return fragmento;
}


// =====================================================================
// EVENTOS
// =====================================================================

elementos.btnNovo.addEventListener("click", abrirFormularioNovo);
elementos.btnImprimir.addEventListener("click", baixarPdf);
elementos.btnCancelar.addEventListener("click", fecharFormulario);
elementos.formLembrete.addEventListener("submit", salvarFormulario);

elementos.descricao.addEventListener("input", () => {
    atualizarContador();

    if (elementos.descricao.value.trim()) {
        limparErroDescricao();
    }
});

// Ctrl + Enter (ou Cmd + Enter no Mac) salva o bilhete
elementos.descricao.addEventListener("keydown", event => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        elementos.formLembrete.requestSubmit();
    }
});

// Esc fecha o bilhete, exceto enquanto está salvando
elementos.formulario.addEventListener("cancel", event => {
    if (elementos.formulario.dataset.salvando === "true") {
        event.preventDefault();
    }
});

// clique fora do papel (no fundo escurecido) fecha os diálogos
[elementos.formulario, elementos.confirmacao].forEach(dialogo => {
    dialogo.addEventListener("click", event => {
        if (event.target === dialogo && dialogo.dataset.salvando !== "true" && !elementos.btnConfirmarExclusao.disabled) {
            dialogo.close();
        }
    });
});

// ações das linhas (delegação de eventos: um único listener para a tabela toda)
elementos.listaLembretes.addEventListener("click", event => {
    const botao = event.target.closest("button[data-acao]");

    if (!botao) {
        return;
    }

    if (botao.dataset.acao === "editar") {
        abrirFormularioEdicao(botao.dataset.id, botao);
    } else if (botao.dataset.acao === "excluir") {
        pedirConfirmacaoExclusao(botao.dataset.id);
    }
});

elementos.btnManter.addEventListener("click", () => elementos.confirmacao.close());
elementos.btnConfirmarExclusao.addEventListener("click", confirmarExclusao);
elementos.confirmacao.addEventListener("close", () => { estado.idParaExcluir = null; });

// filtros: Enter em qualquer campo ou o botão "Filtrar" enviam o formulário
elementos.formFiltros.addEventListener("submit", event => {
    event.preventDefault();
    aplicarFiltros();
});

elementos.btnLimparFiltros.addEventListener("click", limparFiltros);

// valida o período enquanto o usuário escolhe as datas
[elementos.filtroCadastroInicial, elementos.filtroCadastroFinal,
    elementos.filtroAtualizacaoInicial, elementos.filtroAtualizacaoFinal].forEach(campo => {
        campo.addEventListener("change", validarFiltros);
    });

// ordenação: clique no título da coluna
elementos.cabecalhoTabela.addEventListener("click", event => {
    const botao = event.target.closest("button.ordenar");

    if (!botao) {
        return;
    }

    const campo = botao.dataset.campo;

    if (estado.ordem === campo) {
        estado.direcao = estado.direcao === "ASC" ? "DESC" : "ASC";
    } else {
        estado.ordem = campo;
        estado.direcao = CAMPOS_ORDENACAO[campo].direcaoInicial;
    }

    estado.numeroPagina = 1;

    renderizarCabecalhoOrdenacao();
    carregarLembretes();
});

// paginação
function irParaPagina(pagina) {
    if (pagina === estado.numeroPagina) {
        return;
    }

    estado.numeroPagina = pagina;
    carregarLembretes();

    // em telas pequenas, volta para o início da lista
    if (elementos.lista.getBoundingClientRect().top < 0) {
        elementos.lista.scrollIntoView({ behavior: "smooth", block: "start" });
    }
}

elementos.btnAnterior.addEventListener("click", () => irParaPagina(Math.max(1, estado.numeroPagina - 1)));
elementos.btnProximo.addEventListener("click", () => irParaPagina(estado.numeroPagina + 1));

elementos.listaPaginas.addEventListener("click", event => {
    const botao = event.target.closest("button[data-pagina]");

    if (botao) {
        irParaPagina(Number(botao.dataset.pagina));
    }
});

elementos.tamanhoPagina.addEventListener("change", () => {
    estado.tamanhoPagina = Number(elementos.tamanhoPagina.value);
    estado.numeroPagina = 1;
    carregarLembretes();
});

elementos.btnTema.addEventListener("click", () => {
    aplicarTema(document.documentElement.dataset.tema === "lousa" ? "caderno" : "lousa", true);
});


// =====================================================================
// INICIALIZAÇÃO
// =====================================================================

function iniciar() {
    const hoje = new Intl.DateTimeFormat("pt-BR", { weekday: "long", day: "numeric", month: "long", year: "numeric" })
        .format(new Date());
    const destaque = document.createElement("strong");
    destaque.textContent = hoje;
    elementos.hoje.replaceChildren(document.createTextNode("Hoje é "), destaque);

    aplicarTema(document.documentElement.dataset.tema === "lousa" ? "lousa" : "caderno");

    estado.tamanhoPagina = Number(elementos.tamanhoPagina.value);

    // no celular os filtros começam recolhidos para a lista aparecer primeiro
    if (window.matchMedia("(max-width: 760px)").matches) {
        elementos.detalhesFiltros.open = false;
    }

    renderizarCabecalhoOrdenacao();
    renderizarChipsFiltros();
    carregarLembretes();
}

iniciar();
