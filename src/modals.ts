import { App, Modal, Setting } from "obsidian";

/** Ask for a note title; resolves to null if cancelled. */
export function askName(app: App, title: string): Promise<string | null> {
  return new Promise((resolve) => {
    let result: string | null = null;
    const modal = new (class extends Modal {
      onOpen() {
        this.titleEl.setText(title);
        const input = this.contentEl.createEl("input", {
          type: "text",
          cls: "mind-atlas-name-input",
          attr: { placeholder: "Note title" },
        });
        const submit = () => {
          const v = input.value.trim();
          if (!v) return;
          result = v;
          this.close();
        };
        input.addEventListener("keydown", (e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            submit();
          }
        });
        new Setting(this.contentEl).addButton((b) =>
          b.setButtonText("Create").setCta().onClick(submit)
        );
        window.setTimeout(() => input.focus(), 0);
      }
      onClose() {
        this.contentEl.empty();
        resolve(result);
      }
    })(app);
    modal.open();
  });
}

export interface Choice<T extends string> {
  label: string;
  value: T;
  warning?: boolean;
}

/** Ask the user to pick one of several actions; resolves to null if cancelled. */
export function askChoice<T extends string>(
  app: App,
  title: string,
  message: string,
  choices: Choice<T>[]
): Promise<T | null> {
  return new Promise((resolve) => {
    let result: T | null = null;
    const modal = new (class extends Modal {
      onOpen() {
        this.titleEl.setText(title);
        this.contentEl.createEl("p", { text: message });
        const row = new Setting(this.contentEl);
        for (const c of choices) {
          row.addButton((b) => {
            b.setButtonText(c.label).onClick(() => {
              result = c.value;
              this.close();
            });
            if (c.warning) b.setWarning();
          });
        }
        row.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()));
      }
      onClose() {
        this.contentEl.empty();
        resolve(result);
      }
    })(app);
    modal.open();
  });
}
