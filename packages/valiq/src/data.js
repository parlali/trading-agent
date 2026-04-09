function buildQuery(params) {
    const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== null);
    if (entries.length === 0)
        return "";
    const searchParams = new URLSearchParams();
    for (const [key, value] of entries) {
        searchParams.set(key, String(value));
    }
    return `?${searchParams.toString()}`;
}
export class ValiqDataAdapter {
    client;
    constructor(client) {
        this.client = client;
    }
    async getEquityOverview(ticker) {
        return this.client.request(`/equity/${encodeURIComponent(ticker)}`);
    }
    async getPerformance(ticker, cutoff) {
        const query = cutoff ? buildQuery({ cutoff }) : "";
        return this.client.request(`/equity/${encodeURIComponent(ticker)}/price/performance${query}`);
    }
    async getFinancials(ticker, params) {
        const query = params
            ? buildQuery({ limit: params.limit, offset: params.offset, file_name: params.fileName })
            : "";
        return this.client.request(`/equity/${encodeURIComponent(ticker)}/financials${query}`);
    }
    async getRatios(ticker, params) {
        const query = params ? buildQuery(params) : "";
        return this.client.request(`/equity/${encodeURIComponent(ticker)}/ratios${query}`);
    }
    async getFundamentals(ticker, params) {
        const query = params ? buildQuery({ file_name: params.fileName }) : "";
        return this.client.request(`/equity/${encodeURIComponent(ticker)}/fundamentals${query}`);
    }
    async getBeta(ticker, params) {
        const query = params
            ? buildQuery({ history: params.history ? "true" : undefined, limit: params.limit })
            : "";
        return this.client.request(`/equity/${encodeURIComponent(ticker)}/beta${query}`);
    }
    async getNews(ticker, params) {
        const query = params ? buildQuery(params) : "";
        return this.client.request(`/equity/${encodeURIComponent(ticker)}/news${query}`);
    }
    async getSentiment(ticker, params) {
        const query = params ? buildQuery(params) : "";
        return this.client.request(`/equity/${encodeURIComponent(ticker)}/sentiment${query}`);
    }
    async getAnalystRatings(ticker, params) {
        const query = params ? buildQuery(params) : "";
        return this.client.request(`/equity/${encodeURIComponent(ticker)}/analyst/ratings${query}`);
    }
    async getAnalystTargets(ticker, params) {
        const query = params ? buildQuery(params) : "";
        return this.client.request(`/equity/${encodeURIComponent(ticker)}/analyst/targets${query}`);
    }
    async screenAssets(criteria) {
        return this.client.request("/screening/assets", {
            method: "POST",
            body: JSON.stringify(criteria),
        });
    }
    async getMacroEconomy(region, params) {
        const query = params ? buildQuery(params) : "";
        return this.client.request(`/macro/${encodeURIComponent(region)}/economy${query}`);
    }
    async getMacroGrowth(region, params) {
        const query = params ? buildQuery(params) : "";
        return this.client.request(`/macro/${encodeURIComponent(region)}/economy/growth${query}`);
    }
    async getMacroInflation(region, params) {
        const query = params ? buildQuery(params) : "";
        return this.client.request(`/macro/${encodeURIComponent(region)}/economy/inflation${query}`);
    }
    async getMacroLabor(region, params) {
        const query = params ? buildQuery(params) : "";
        return this.client.request(`/macro/${encodeURIComponent(region)}/economy/labor${query}`);
    }
    async getMacroStability(region, params) {
        const query = params ? buildQuery(params) : "";
        return this.client.request(`/macro/${encodeURIComponent(region)}/economy/stability${query}`);
    }
    async getMacroMoneySupply(region, params) {
        const query = params ? buildQuery(params) : "";
        return this.client.request(`/macro/${encodeURIComponent(region)}/economy/money-supply${query}`);
    }
    async getMacroEnergy(region, params) {
        const query = params ? buildQuery(params) : "";
        return this.client.request(`/macro/${encodeURIComponent(region)}/energy${query}`);
    }
    async getMacroOil(region, params) {
        const query = params ? buildQuery(params) : "";
        return this.client.request(`/macro/${encodeURIComponent(region)}/energy/oil${query}`);
    }
    async getMacroGas(region, params) {
        const query = params ? buildQuery(params) : "";
        return this.client.request(`/macro/${encodeURIComponent(region)}/energy/gas${query}`);
    }
    async getMacroEvents(region, params) {
        const query = params ? buildQuery(params) : "";
        return this.client.request(`/macro/${encodeURIComponent(region)}/events${query}`);
    }
    async getMacroNews(region, params) {
        const query = params ? buildQuery(params) : "";
        return this.client.request(`/macro/${encodeURIComponent(region)}/news${query}`);
    }
    async getMacroAnalysis(region, params) {
        const query = params ? buildQuery(params) : "";
        return this.client.request(`/macro/${encodeURIComponent(region)}/analysis${query}`);
    }
    async getMacroRiskFreeRate(region, params) {
        const query = buildQuery(params);
        return this.client.request(`/macro/${encodeURIComponent(region)}/rates/risk-free${query}`);
    }
    async getBreakingNews(params) {
        const query = params ? buildQuery(params) : "";
        return this.client.request(`/breaking-news${query}`);
    }
}
