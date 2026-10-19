/**
 * A few metrics in the Prometheus text format, served at `/metrics`. Small
 * enough to write by hand, and it shows what the format is: lines of
 * `name{label="value"} number`, with HELP and TYPE comments.
 */

type Labels = Readonly<Record<string, string>>;

interface Metric {
  render(): string[];
}

const escapeLabel = (value: string) =>
  value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n");

function series(name: string, labels: Labels, value: number): string {
  const pairs = Object.entries(labels).map(([key, v]) => `${key}="${escapeLabel(v)}"`);
  const number = Number.isFinite(value) ? String(value) : value > 0 ? "+Inf" : "-Inf";
  return `${name}${pairs.length > 0 ? `{${pairs.join(",")}}` : ""} ${number}`;
}

/** Only ever goes up. Each set of labels is its own series. */
export class Counter implements Metric {
  private readonly values = new Map<string, { labels: Labels; value: number }>();

  /**
   * `start` lists the series shown at 0 before anything happens, so a
   * dashboard's rate() has a starting point. Default: the one without labels.
   */
  constructor(
    private readonly name: string,
    private readonly help: string,
    start: readonly Labels[] = [{}],
  ) {
    for (const labels of start) this.inc(labels, 0);
  }

  inc(labels: Labels = {}, by = 1): void {
    const key = JSON.stringify(labels);
    const entry = this.values.get(key);
    if (entry) entry.value += by;
    else this.values.set(key, { labels, value: by });
  }

  render(): string[] {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    for (const { labels, value } of this.values.values())
      lines.push(series(this.name, labels, value));
    return lines;
  }
}

/** A value read when scraped: a gauge (goes up and down) or a counter kept elsewhere. */
export class Sampled implements Metric {
  constructor(
    private readonly name: string,
    private readonly type: "gauge" | "counter",
    private readonly help: string,
    private readonly read: () => number,
  ) {}

  render(): string[] {
    return [
      `# HELP ${this.name} ${this.help}`,
      `# TYPE ${this.name} ${this.type}`,
      series(this.name, {}, this.read()),
    ];
  }
}

/** Counts observations into buckets: how many were at most each bound. */
export class Histogram implements Metric {
  private readonly counts: number[];
  private sum = 0;
  private count = 0;

  constructor(
    private readonly name: string,
    private readonly help: string,
    private readonly bounds: readonly number[],
  ) {
    this.counts = bounds.map(() => 0);
  }

  observe(value: number): void {
    this.sum += value;
    this.count++;
    for (let i = 0; i < this.bounds.length; i++) {
      if (value <= (this.bounds[i] as number)) this.counts[i] = (this.counts[i] as number) + 1;
    }
  }

  render(): string[] {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    this.bounds.forEach((bound, i) => {
      lines.push(series(`${this.name}_bucket`, { le: String(bound) }, this.counts[i] as number));
    });
    lines.push(series(`${this.name}_bucket`, { le: "+Inf" }, this.count));
    lines.push(series(`${this.name}_sum`, {}, this.sum));
    lines.push(series(`${this.name}_count`, {}, this.count));
    return lines;
  }
}

export class Registry {
  private readonly metrics: Metric[] = [];

  add<M extends Metric>(metric: M): M {
    this.metrics.push(metric);
    return metric;
  }

  render(): string {
    return `${this.metrics.flatMap((metric) => metric.render()).join("\n")}\n`;
  }
}

export const CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8";
