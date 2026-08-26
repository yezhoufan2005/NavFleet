import pino from "pino";
import { config } from "./config";

/** Shared application logger (data-pipeline modules keep their own named loggers). */
export const logger = pino({ name: "fleet-backend", level: config.logLevel });
