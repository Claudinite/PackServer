export const PUSHOVER_URL = "https://api.pushover.net/1/messages.json";

export interface PushoverConfig {
  /** The application token; the one recipient is the user key below and nothing a caller passes can change it. */
  token: () => Promise<string>;
  /** Ariel's user key. */
  user: () => Promise<string>;
}

export interface Push {
  title: string;
  message: string;
  /** The ops page, opened by tapping the notification. */
  url: string;
  urlTitle: string;
  /** -1 is quiet; a test page uses it, a real page does not. */
  priority: -1 | 0 | 1;
}

export interface Pager {
  send(push: Push): Promise<void>;
}

export function pushoverPager(config: PushoverConfig, fetchImpl: typeof fetch = fetch): Pager {
  return {
    async send(push) {
      const body = new URLSearchParams({
        token: await config.token(),
        user: await config.user(),
        title: push.title,
        message: push.message,
        priority: String(push.priority),
        ...(push.url ? { url: push.url, url_title: push.urlTitle } : {}),
      });
      const response = await fetchImpl(PUSHOVER_URL, { method: "POST", body });
      if (!response.ok) throw new Error(`Pushover answered ${response.status}`);
    },
  };
}
