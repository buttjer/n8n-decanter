export class N8nApi {
  #host;
  #apiKey;

  constructor({ host, apiKey }) {
    this.#host = host;
    this.#apiKey = apiKey;
  }

  async getWorkflow(id) {
    return this.#request("GET", `/api/v1/workflows/${encodeURIComponent(id)}`);
  }

  async updateWorkflow(id, body) {
    return this.#request("PUT", `/api/v1/workflows/${encodeURIComponent(id)}`, body);
  }

  async #request(method, pathname, body) {
    const res = await fetch(this.#host + pathname, {
      method,
      headers: {
        "X-N8N-API-KEY": this.#apiKey,
        accept: "application/json",
        ...(body !== undefined && { "content-type": "application/json" }),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`${method} ${pathname} failed: ${res.status} ${res.statusText}\n${text.slice(0, 2000)}`);
    }
    return text ? JSON.parse(text) : undefined;
  }
}
