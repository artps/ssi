// functions/_middleware.js

export const onRequest = async ({ request, env, next }) => {
	let response = await next();

	// Process only HTML responses
	if (!response.headers.get("content-type")?.includes("text/html")) {
		return response;
	}

	// Initialize shared state
	let slotBuffer = new Map();
	let elementStack = [];

	return new HTMLRewriter()
		.on("*", new UniversalHandler(env, request, slotBuffer, elementStack))
		.transform(response);
};

class UniversalHandler {
	constructor(env, request, slotBuffer, elementStack) {
		this.env = env;
		this.request = request;
		this.slotBuffer = slotBuffer;
		this.elementStack = elementStack;
		this.currentSlot = null;
		this.fillContent = new Map();
	}

	element(element) {
		const tagName = element.tagName.toLowerCase();
		const node = {
			type: "element",
			tag: tagName,
			attributes: {},
			children: [],
		};

		for (const [name, value] of element.attributes) {
			node.attributes[name] = value;
		}

		this.elementStack.push(node);

		if (tagName === "include") {
			const includePath = element.getAttribute("path");
			if (!includePath) return;

			if (this.currentSlot) {
				let parentFill = this.fillContent.get(this.currentSlot);
				if (parentFill) {
					parentFill.children.push(node);
				}
			}

			this.slotBuffer.set(includePath, new Map());

			element.onEndTag(async (tag) => {
				const finalText = await this.processInclude(includePath);
				tag.after(finalText, { html: true });
				this.elementStack.pop();
			});

			element.remove();
		} else if (tagName === "fill") {
			const slotName = element.getAttribute("slot");
			if (!slotName) return;

			this.currentSlot = slotName;
			this.fillContent.set(slotName, { type: "root", children: [] });

			element.onEndTag(() => {
				const parentInclude = this.findParentInclude();
				if (parentInclude) {
					if (!this.slotBuffer.has(parentInclude)) {
						this.slotBuffer.set(parentInclude, new Map());
					}
					this.slotBuffer.get(parentInclude).set(slotName, node);
				}

				this.currentSlot = null;
				this.elementStack.pop();
			});

			element.remove();
		} else {
			if (this.currentSlot) {
				let fillTree = this.fillContent.get(this.currentSlot);
				if (fillTree) {
					let parent =
						this.elementStack.length > 1
							? this.elementStack[this.elementStack.length - 2]
							: null;
					if (parent) {
						parent.children.push(node);
					} else {
						fillTree.children.push(node);
					}
				}
			}

			try {
				element.onEndTag(() => {
					this.elementStack.pop();
				});
			} catch {}
		}
	}

	text(textChunk) {
		if (this.currentSlot) {
			const textNode = { type: "text", content: textChunk.text };

			let fillNode = this.fillContent.get(this.currentSlot);
			if (fillNode) {
				let parent =
					this.elementStack.length > 0
						? this.elementStack[this.elementStack.length - 1]
						: null;
				if (parent) {
					parent.children.push(textNode);
					fillNode.children.push(parent);
				} else {
					fillNode.children.push(textNode);
				}
			}
		}
	}

	findParentInclude() {
		return (
			[...this.elementStack].reverse().find((node) => node.tag === "include")
				?.attributes?.path || null
		);
	}

	async processInclude(includePath) {
		const slotMap = this.slotBuffer.get(includePath) || new Map();

		try {
			const url = new URL(includePath, this.request.url);
			const includeResponse = await fetch(url);

			if (!includeResponse.ok) {
				throw new Error(`Failed to fetch ${includePath}`);
			}

			const includeText = await includeResponse.text();

			let processedHTML = await new HTMLRewriter()
				.on("slot", new SlotHandler(slotMap))
				.transform(
					new Response(includeText, {
						headers: { "content-type": "text/html" },
					}),
				)
				.text();

			return processedHTML;
		} catch (error) {
			return `<!-- Failed to include: ${includePath} -->`;
		}
	}
}

class SlotHandler {
	constructor(slotMap) {
		this.slotMap = slotMap;
	}

	element(element) {
		const slotName = element.getAttribute("name");
		if (!slotName) {
			element.remove();
			return;
		}

		if (this.slotMap.has(slotName)) {
			const slotContent = this.renderTree(this.slotMap.get(slotName));
			element.replace(slotContent, { html: true });
		}
	}

	renderTree(node) {
		if (!node || !node.children || node.children.length === 0) return "";

		return node.children
			.map((child) => {
				if (child.type === "text") return child.content;

				const attributes = Object.entries(child.attributes || {})
					.map(([key, value]) => ` ${key}="${value}"`)
					.join("");

				const children = this.renderTree(child);
				return `<${child.tag}${attributes}>${children}</${child.tag}>`;
			})
			.join("");
	}
}
