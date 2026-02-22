// Grafana logger setup
import { createLogger, transports, format } from "winston";
import LokiTransport from "winston-loki";

const logger = createLogger({
  level: "info",
  format: format.combine(format.timestamp(), format.json()),
  transports: [
    new transports.Console({
      format: format.combine(format.colorize(), format.simple()),
    }),
    new LokiTransport({
      host: process.env.GRAFANA_LOKI_HOST || "",
      basicAuth: `${process.env.GRAFANA_INSTANCE_ID}:${process.env.GRAFANA_API_KEY}`,
      labels: { app: "dev-elevator-server" },
      json: true,
      format: format.json(),
      replaceTimestamp: true,
      batching: false,
      onConnectionError: (err) =>
        logger.error("Grafana Connection Error:", err),
    }),
  ],
});

logger.on("error", (err) => {
  console.error(" Winston Internal Error:", err);
});

export { logger };
