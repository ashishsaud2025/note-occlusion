import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type NoteOcclusionPlugin from "./main";
import { MODE_DELETE, MODE_DRAW, MODE_PASS, MODE_REVEAL, Mode } from "./types";

export class OcclusionSettingsTab extends PluginSettingTab {
	private plugin: NoteOcclusionPlugin;

	constructor(app: App, plugin: NoteOcclusionPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

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
					.setDynamicTooltip()
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
						const parsed = value
							.split(",")
							.map((s) => s.trim())
							.filter((s) => /^#[0-9a-fA-F]{6}$/.test(s));
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
