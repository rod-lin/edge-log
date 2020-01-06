import { graphql, GraphQLSchema } from "graphql";

/**
 * Minimal web application framework
 */

export class Route {
    constructor(
        public method: string,
        public pattern: RegExp,
        public handler: string
    ) {
        this.method = this.method.toLowerCase();
    }

    match(request: HTTPRequest): RegExpExecArray | null {
        if (request.method.toLowerCase() !== this.method) {
            return null;
        }

        return this.pattern.exec(request.url.pathname);
    }
}

export class HTTPRequest {
    public method: string;
    public url: URL;
    public query: URLSearchParams;
    public headers: Headers;
    public cookie: CookieJar;

    constructor(private request: Request) {
        this.method = request.method;
        this.url = new URL(request.url);
        this.query = this.url.searchParams;
        this.headers = request.headers;
        this.cookie = new CookieJar(request.headers.get("cookie") || "");
    }

    async formData(): Promise<FormData> {
        return await this.request.formData();
    }

    async json(): Promise<any> {
        return await this.request.json();
    }

    async text(): Promise<string> {
        return await this.request.text();
    }
}

export abstract class Application {
    static readonly ROUTE_NAME: unique symbol = Symbol();

    static method(name: string) {
        return (pattern: string) => {
            return (target: any, property: string) => {
                if (!target.hasOwnProperty(Application.ROUTE_NAME)) {
                    target[Application.ROUTE_NAME] = [];
                }

                target[Application.ROUTE_NAME].push(
                    new Route(name, new RegExp("^" + pattern + "$"), property)
                );
            };
        };
    }

    /**
     * HTTP methods
     */
    static get = Application.method("get");
    static post = Application.method("post");
    static put = Application.method("put");
    static delete = Application.method("delete");
    static options = Application.method("options");

    async handleNotFound(request: HTTPRequest): Promise<HTTPResponse> {
        return { text: "404 not found", status: 404 };
    }

    async handleInternalError(request: HTTPRequest): Promise<HTTPResponse> {
        return { text: "500 internal error", status: 500 };
    }

    /**
     * https://graphql.org/learn/serving-over-http/
     */
    async getGraphQLQuery(
        request: HTTPRequest
    ): Promise<{
        query: string;
        operationName?: string;
        variables?: { [key: string]: any };
    } | null> {
        switch (request.method.toLowerCase()) {
            case "get":
                const query = request.query.get("query");
                const operationName =
                    request.query.get("operationName") || undefined;
                const variables = request.query.get("variables") || undefined;

                if (query === null) return null;

                try {
                    return {
                        query: query,
                        operationName: operationName,
                        variables:
                            variables !== undefined
                                ? JSON.parse(variables)
                                : undefined,
                    };
                } catch (e) {
                    // parse failed
                    return null;
                }

            case "post":
                switch (request.headers.get("content-type")) {
                    case "application/json":
                        return (await request.json()) as {
                            query: string;
                            operationName?: string;
                            variables?: { [key: string]: any };
                        };

                    case "application/graphql":
                        return {
                            query: await request.text(),
                        };
                }
        }

        return null;
    }

    /**
     * GraphQL HTTP endpoint
     */
    async handleGraphQLRequest(
        schema: GraphQLSchema,
        request: HTTPRequest
    ): Promise<HTTPResponse> {
        const graphQLRequest = await this.getGraphQLQuery(request);

        if (graphQLRequest === null) {
            return { status: 400, text: "400 bad request" };
        }

        return {
            json: await graphql(
                schema,
                graphQLRequest.query,
                undefined,
                undefined,
                graphQLRequest.variables,
                graphQLRequest.operationName
            ),
        };
    }

    async handleRequest(request: Request): Promise<Response> {
        const parsedRequest = new HTTPRequest(request);

        const proto: ApplicationPrototype = Object.getPrototypeOf(this);

        for (const route of proto[Application.ROUTE_NAME]) {
            const match = route.match(parsedRequest);

            if (match !== null) {
                const handler: RequestHandler = (this as any)[
                    route.handler
                ].bind(this);

                try {
                    const response = await handler(
                        parsedRequest,
                        ...match.slice(1)
                    );
                    return Application.encodeResponse(response);
                } catch (e) {
                    console.log(e);
                    return Application.encodeResponse(
                        await this.handleInternalError(parsedRequest)
                    );
                }
            }
        }

        return Application.encodeResponse(
            await this.handleNotFound(parsedRequest)
        );
    }

    private static encodeResponse(responseObj: HTTPResponse): Response {
        const headers: HTTPHeaders = responseObj["headers"] || {};

        const status =
            responseObj["status"] !== undefined ? responseObj["status"] : 200;

        let response: string | ReadableStream = "";

        if ("json" in responseObj) {
            response = JSON.stringify(responseObj["json"]);
            headers["content-type"] = "application/json";
        } else if ("text" in responseObj) {
            response = responseObj["text"];
            headers["content-type"] = "text/plain";
        } else if ("html" in responseObj) {
            response = responseObj["html"];
            headers["content-type"] = "text/html";
        } else if ("stream" in responseObj) {
            response = responseObj["stream"];
        }

        let key: keyof HTTPHeaders;
        const encodedHeaders: Record<string, string> = {};

        for (key in headers) {
            if (headers[key] !== undefined) {
                encodedHeaders[key] = headers[key]!.toString();
            }
        }

        return new Response(response, {
            status,
            headers: encodedHeaders,
        });
    }

    static inferContentType(fileName: string): ContentType {
        const dotIndex = fileName.lastIndexOf(".");

        if (dotIndex != -1) {
            const suffix = fileName.substr(dotIndex + 1);
            const contentTypeMap: Record<string, ContentType> = {
                json: "application/json",
                js: "application/javascript",
                html: "text/html",
                css: "text/css",
                txt: "text/html",
            };

            if ((contentTypeMap as Object).hasOwnProperty(suffix)) {
                return contentTypeMap[suffix];
            }
        }

        return "application/octet-stream";
    }
}

export class CookieJar {
    [key: string]: string;

    constructor(cookie: string) {
        /**
         * https://gist.github.com/rendro/525bbbf85e84fa9042c2#gistcomment-2784930
         */
        cookie.split(";").reduce((res, c) => {
            const [key, val] = c
                .trim()
                .split("=")
                .map(decodeURIComponent);
            return Object.assign(res, { [key]: val });
        }, this);
    }
}

CookieJar.prototype.toString = function(): string {
    const pairs: string[] = [];

    for (const key in this) {
        if ((this as Object).hasOwnProperty(key)) {
            pairs.push(
                `${encodeURIComponent(key)}=${encodeURIComponent(this[key])}`
            );
        }
    }

    return pairs.join(";");
};

export type RequestHandler = (
    r: HTTPRequest,
    ...m: string[]
) => Promise<HTTPResponse>;

export type ApplicationPrototype = {
    [Application.ROUTE_NAME]: Route[];
};

export type ContentType =
    | "application/json"
    | "application/javascript"
    | "application/octet-stream"
    | "text/plain"
    | "text/css"
    | "text/html";

export type HTTPHeaders = {
    "content-type"?: ContentType;
    "set-cookie"?: CookieJar;
    authorization?: string;
    "access-control-allow-origin"?: string;
    "access-control-allow-headers"?: string;
    "access-control-allow-methods"?: string;
    cookie?: CookieJar;
};

export type HTTPResponse = {
    status?: number;
    headers?: HTTPHeaders;
} & (
    | { json: any }
    | { text: string }
    | { html: string }
    | { stream: ReadableStream }
    | {}
);
