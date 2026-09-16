import { App, Notice, PluginSettingTab, Setting, SettingDefinitionItem } from "obsidian";
import type NoteOcclusionPlugin from "./main";
import { MODE_DELETE, MODE_DRAW, MODE_PASS, MODE_REVEAL, Mode } from "./types";

type OcclusionControlKey =
	| "defaultColor"
	| "startMode"
	| "showToolbarOnStart"
	| "markRevealed"
	| "coverOpacity"
	| "swatches";

function parseSwatches(value: string): string[] {
	return value
		.split(",")
		.map((s) => s.trim())
		.filter((s) => /^#[0-9a-fA-F]{6}$/.test(s));
}

export class OcclusionSettingsTab extends PluginSettingTab {
	private plugin: NoteOcclusionPlugin;

	constructor(app: App, plugin: NoteOcclusionPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	getControlValue(key: string): unknown {
		const settings = this.plugin.store.settings;
		if (key === "swatches") return settings.swatches.join(", ");
		return (settings as unknown as Record<string, unknown>)[key];
	}

	async setControlValue(key: string, value: unknown): Promise<void> {
		const settings = this.plugin.store.settings;
		switch (key as OcclusionControlKey) {
			case "defaultColor":
				settings.defaultColor = String(value);
				this.plugin.setColor(settings.defaultColor);
				break;
			case "startMode":
				settings.startMode = value as Mode;
				break;
			case "showToolbarOnStart":
				settings.showToolbarOnStart = Boolean(value);
				break;
			case "markRevealed":
				settings.markRevealed = Boolean(value);
				this.plugin.renderAll();
				break;
			case "coverOpacity":
				settings.coverOpacity = Number(value);
				this.plugin.renderAll();
				break;
			case "swatches": {
				const parsed = parseSwatches(String(value));
				if (parsed.length) settings.swatches = parsed;
				break;
			}
		}
		await this.plugin.store.saveSettings();
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		const paths = this.plugin.store.knownPaths();
		const orphanLabel = `${paths.length} note${paths.length === 1 ? "" : "s"} have covers saved`;
		return [
			{
				name: "Cover colour",
				desc: "Used for new covers.",
				control: {
					type: "color",
					key: "defaultColor",
				},
			},
			{
				name: "Mode when Obsidian starts",
				desc:
					"Reveal lets you click covers. Pass leaves the note fully editable. " +
					"Draw takes over the mouse so you can paint.",
				control: {
					type: "dropdown",
					key: "startMode",
					options: {
						[MODE_REVEAL]: "Reveal",
						[MODE_PASS]: "Pass",
						[MODE_DRAW]: "Draw",
						[MODE_DELETE]: "Delete",
					},
				},
			},
			{
				name: "Show the toolbar at startup",
				control: {
					type: "toggle",
					key: "showToolbarOnStart",
				},
			},
			{
				name: "Outline revealed covers",
				desc: "Draw a dotted border where a cover is, so you can hide it again.",
				control: {
					type: "toggle",
					key: "markRevealed",
				},
			},
			{
				name: "Cover opacity",
				desc: "Below 1 the text shows through faintly. 1 hides it completely.",
				control: {
					type: "slider",
					key: "coverOpacity",
					min: 0.2,
					max: 1,
					step: 0.05,
					displayFormat: (value: number) => String(value),
				},
			},
			{
				name: "Swatches",
				desc: "Comma separated hex colours shown in the toolbar and right-click menu.",
				control: {
					type: "text",
					key: "swatches",
					validate: (value: string) =>
						parseSwatches(value).length
							? undefined
							: "Enter comma-separated hex colours such as #ffffff, #1e1e1e.",
				},
			},
			{
				type: "group",
				heading: "Stored covers",
				items: [
					{
						name: orphanLabel,
						desc: "Covers are kept in this plugin's data.json, not inside your notes.",
						render: (setting: Setting) => {
							setting.addButton((button) =>
								button.setButtonText("Remove orphans").onClick(async () => {
									const removed = this.plugin.store.prune(
										(path) => this.app.vault.getAbstractFileByPath(path) !== null
									);
									await this.plugin.store.forceSave();
									new Notice(
										removed === 0
											? "Nothing to clean up."
											: `Removed covers for ${removed} missing note${removed === 1 ? "" : "s"}.`
									);
									this.update();
								})
							);
						},
					},
				],
			},
		];
	}

	/**
	 * Fallback for Obsidian versions older than 1.13.0, which do not call
	 * getSettingDefinitions(). Newer versions render declaratively and ignore
	 * this method.
	 */
	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		const settings = this.plugin.store.settings;

		new Setting(containerEl)
			.setName("Cover colour")
			.setDesc("Used for new covers.")
			.addColorPicker((picker) =>
				picker.setValue(settings.defaultColor).onChange(async (value) => {
					settings.defaultColor = value;
					this.plugin.setColor(value);
					await this.plugin.store.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Mode when Obsidian starts")
			.setDesc(
				"Reveal lets you click covers. Pass leaves the note fully editable. " +
					"Draw takes over the mouse so you can paint."
			)
			.addDropdown((drop) =>
				drop
					.addOption(MODE_REVEAL, "Reveal")
					.addOption(MODE_PASS, "Pass")
					.addOption(MODE_DRAW, "Draw")
					.addOption(MODE_DELETE, "Delete")
					.setValue(settings.startMode)
					.onChange(async (value) => {
						settings.startMode = value as Mode;
						await this.plugin.store.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Show the toolbar at startup")
			.addToggle((toggle) =>
				toggle.setValue(settings.showToolbarOnStart).onChange(async (value) => {
					settings.showToolbarOnStart = value;
					await this.plugin.store.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Outline revealed covers")
			.setDesc("Draw a dotted border where a cover is, so you can hide it again.")
			.addToggle((toggle) =>
				toggle.setValue(settings.markRevealed).onChange(async (value) => {
					settings.markRevealed = value;
					await this.plugin.store.saveSettings();
					this.plugin.renderAll();
				})
			);

		new Setting(containerEl)
			.setName("Cover opacity")
			.setDesc("Below 1 the text shows through faintly. 1 hides it completely.")
			.addSlider((slider) =>
				slider
					.setLimits(0.2, 1, 0.05)
					.setValue(settings.coverOpacity)
					.onChange(async (value) => {
						settings.coverOpacity = value;
						await this.plugin.store.saveSettings();
						this.plugin.renderAll();
					})
			);

		new Setting(containerEl)
			.setName("Swatches")
			.setDesc("Comma separated hex colours shown in the toolbar and right-click menu.")
			.addText((text) =>
				text
					.setValue(settings.swatches.join(", "))
					.onChange(async (value) => {
						const parsed = parseSwatches(value);
						if (parsed.length) {
							settings.swatches = parsed;
							await this.plugin.store.saveSettings();
						}
					})
			);

		new Setting(containerEl).setName("Stored covers").setHeading();

		const paths = this.plugin.store.knownPaths();
		new Setting(containerEl)
			.setName(`${paths.length} note${paths.length === 1 ? "" : "s"} have covers saved`)
			.setDesc("Covers are kept in this plugin's data.json, not inside your notes.")
			.addButton((button) =>
				button.setButtonText("Remove orphans").onClick(async () => {
					const removed = this.plugin.store.prune((path) =>
						this.app.vault.getAbstractFileByPath(path) !== null
					);
					await this.plugin.store.forceSave();
					new Notice(
						removed === 0
							? "Nothing to clean up."
							: `Removed covers for ${removed} missing note${removed === 1 ? "" : "s"}.`
					);
					this.display();
				})
			);
	}
}
