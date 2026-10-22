export {
	CHROME_TIMEOUT_MS,
	chromeCandidates,
	findChrome,
	lastChromeArgs,
} from "./chrome.js";
export {
	type Block,
	type CoverFormat,
	coverText,
	parseCoverMarkdown,
	renderCover,
} from "./cover.js";
export { docxDocumentXml, readZipEntry, renderDocx } from "./docx.js";
export {
	artifactBaseName,
	estimateFit,
	type FitResult,
	FORMATS,
	type Format,
	fitPages,
	type RenderResult,
	renderAll,
	resumeBaseName,
} from "./fit.js";
export { escapeHtml, formatDate, formatRange, renderHtml } from "./html.js";
export {
	DEFAULT_LAYOUT_SPEC,
	evaluateLayout,
	type LayoutGateResult,
	type LayoutMeasure,
	type LayoutSpec,
	layoutGate,
	layoutSpecFrom,
	measureLayout,
	measurementHtml,
	parseLayoutDump,
} from "./layout.js";
export { countPdfPages, pdfHasText, renderPdf } from "./pdf.js";
export { renderText } from "./text.js";
export {
	DENSITIES,
	type Density,
	densityCss,
	densitySpec,
	THEME_CSS,
} from "./theme.js";
