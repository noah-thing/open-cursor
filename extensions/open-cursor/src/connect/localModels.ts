/*---------------------------------------------------------------------------------------------
 *  OpenCursor. MIT License.
 *  Which local models fit this computer. Plain arithmetic on memory, graphics memory and disk:
 *  a model needs its download size in memory plus room for the conversation, and the space on disk.
 *--------------------------------------------------------------------------------------------*/

export interface LocalModel {
	/** Ollama tag, e.g. qwen3-coder:30b */
	readonly tag: string;
	readonly label: string;
	readonly note: string;
	/** Download size in GB, from the Ollama registry on 2026-10-30. */
	readonly sizeGB: number;
}

/** Best first. Every one of these calls tools, which the agent needs. */
export const LOCAL_MODELS: readonly LocalModel[] = [
	{ tag: 'qwen3-coder:30b', label: 'Qwen3 Coder 30B', note: 'Made for coding agents. Only 3B of it runs per token, so it is quick for its size.', sizeGB: 18.6 },
	{ tag: 'qwen3.8:27b', label: 'Qwen 3.8 27B', note: 'Newest Qwen. Strong all round, codes well.', sizeGB: 17.7 },
	{ tag: 'devstral:24b', label: 'Devstral 24B', note: 'Mistral\'s model for agents that edit code.', sizeGB: 14.3 },
	{ tag: 'gpt-oss:20b', label: 'GPT-OSS 20B', note: 'OpenAI\'s open model. Good reasoning, fast.', sizeGB: 13.8 },
	{ tag: 'qwen3:14b', label: 'Qwen3 14B', note: 'Solid all round model that thinks before it answers.', sizeGB: 9.3 },
	{ tag: 'qwen2.5-coder:14b', label: 'Qwen2.5 Coder 14B', note: 'Coding model, also good for Tab.', sizeGB: 9.0 },
	{ tag: 'qwen3.5:9b', label: 'Qwen 3.5 9B', note: 'Small and capable. A good start on most laptops.', sizeGB: 6.6 },
	{ tag: 'qwen2.5-coder:7b', label: 'Qwen2.5 Coder 7B', note: 'Coding model for smaller machines.', sizeGB: 4.7 },
	{ tag: 'qwen3.5:4b', label: 'Qwen 3.5 4B', note: 'Light. Fine for questions and small edits.', sizeGB: 3.3 },
	{ tag: 'qwen2.5-coder:3b', label: 'Qwen2.5 Coder 3B', note: 'Tiny and fast. Best used for Tab.', sizeGB: 1.9 },
	{ tag: 'qwen2.5-coder:1.5b', label: 'Qwen2.5 Coder 1.5B', note: 'The smallest. Runs almost anywhere.', sizeGB: 1.0 },
];

export interface Hardware {
	readonly platform: NodeJS.Platform;
	readonly arch: string;
	readonly cpu: string;
	readonly memGB: number;
	/** Largest NVIDIA card, when nvidia-smi answers. */
	readonly gpu?: { readonly name: string; readonly memGB: number };
	readonly diskFreeGB?: number;
}

export type Speed = 'fast' | 'slow';

export interface Budget {
	/** Memory a model may use, in GB. */
	readonly gb: number;
	readonly speed: Speed;
	/** One line that says what was found, for the page. */
	readonly summary: string;
}

const round = (n: number): number => Math.round(n);

/**
 * Apple silicon shares memory with the graphics chip and lets a model use about two thirds of it.
 * An NVIDIA card runs what fits in its own memory. Anything else runs on the processor: it works,
 * only slower, so it is held to small models.
 */
export function budget(hw: Hardware): Budget {
	if (hw.platform === 'darwin' && hw.arch === 'arm64') {
		return { gb: hw.memGB * 0.66, speed: 'fast', summary: `${hw.cpu || 'Apple silicon'}, ${round(hw.memGB)} GB memory` };
	}
	if (hw.gpu && hw.gpu.memGB >= 4) {
		return { gb: hw.gpu.memGB * 0.92, speed: 'fast', summary: `${hw.gpu.name}, ${round(hw.gpu.memGB)} GB graphics memory` };
	}
	return { gb: Math.min(hw.memGB * 0.5, 8), speed: 'slow', summary: `${round(hw.memGB)} GB memory, no supported graphics card: models run on the processor, slower` };
}

/** Memory a model takes once loaded: the weights plus the conversation it keeps in memory (16k tokens). */
export function needGB(m: LocalModel): number {
	return m.sizeGB * 1.05 + 1.5;
}

export interface Pick {
	readonly model: LocalModel;
	readonly recommended: boolean;
	/** Fits, but leaves little room for other apps. */
	readonly tight: boolean;
	readonly diskOk: boolean;
}

/** The models that fit, best first, at most `max`; the first is the recommendation. */
export function pickModels(hw: Hardware, max = 4): Pick[] {
	const b = budget(hw);
	const fits = LOCAL_MODELS.filter(m => needGB(m) <= b.gb);
	return fits.slice(0, max).map((m, i) => ({
		model: m,
		recommended: i === 0,
		tight: needGB(m) > b.gb * 0.85,
		diskOk: hw.diskFreeGB === undefined || hw.diskFreeGB >= m.sizeGB + 2,
	}));
}

/** `name, memory.total` lines from `nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits` (MiB). */
export function parseNvidiaSmi(out: string): Hardware['gpu'] {
	let best: Hardware['gpu'];
	for (const line of out.split(/\r?\n/)) {
		const i = line.lastIndexOf(',');
		if (i < 0) { continue; }
		const name = line.slice(0, i).trim();
		const mib = Number(line.slice(i + 1).trim());
		if (!name || !Number.isFinite(mib) || mib <= 0) { continue; }
		const gb = mib / 1024;
		if (!best || gb > best.memGB) { best = { name: name.replace(/^NVIDIA\s+/i, 'NVIDIA '), memGB: gb }; }
	}
	return best;
}
