import { createContext } from "react";

/** The run turn the rows below it belong to, so a row can open Review on that turn. */
export const TurnIdContext = createContext<string | undefined>(undefined);
