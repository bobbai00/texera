import { queryOptions } from "@tanstack/react-query";
import { datasetsDownload } from "@texera/catalog-client";
import { datasetsFilesOptions, datasetsReadOptions, datasetsStagedOptions } from "@texera/catalog-client/query";
import { unwrap } from "../api";
import { delimiterFor, previewCsv, type TablePreview } from "./csv";

const PREVIEW_BYTES = 256 * 1024;

export const datasetQuery = (rid: string) => datasetsReadOptions({ path: { rid } });
export const filesQuery = (rid: string, vno: number) => datasetsFilesOptions({ path: { rid, vno } });
export const stagedQuery = (rid: string) => datasetsStagedOptions({ path: { rid } });

/** The first rows of a tabular file of a version, read through the catalog. */
export const previewQuery = (rid: string, vno: number, path: string) =>
  queryOptions({
    queryKey: ["dataset-preview", rid, vno, path],
    queryFn: async (): Promise<TablePreview> => {
      const data = await unwrap(
        datasetsDownload({ path: { rid, vno, path }, query: { maxBytes: PREVIEW_BYTES }, parseAs: "text" })
      );
      const text = typeof data === "string" ? data : data instanceof Blob ? await data.text() : "";
      return previewCsv(text, { truncated: text.length >= PREVIEW_BYTES, delimiter: delimiterFor(path) });
    },
    staleTime: Number.POSITIVE_INFINITY,
  });
