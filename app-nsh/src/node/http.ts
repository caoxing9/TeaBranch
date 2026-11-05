import type { HttpRequest, HttpResponse, HttpServer } from 'teabranch/native'

/**
 * Answer a Rust `HttpServer` with an async handler. The Rust side settles a returned promise
 * before replying; only the generated type says the handler returns the response itself.
 */
export function serve(server: HttpServer, handler: (request: HttpRequest) => Promise<HttpResponse> | HttpResponse): void {
  void server.serve(handler as unknown as (request: HttpRequest) => HttpResponse)
}
