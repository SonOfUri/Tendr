/**
 * Hostnames treated as the developer's own machine. Outside production, `http://` is accepted for
 * these only (checkout domains, test-mode webhook endpoints, Connect site URLs).
 */
export const LOCAL_DEV_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]']);
