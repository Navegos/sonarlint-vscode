/* --------------------------------------------------------------------------------------------
 * SonarLint for VisualStudio Code
 * Copyright (C) 2017-2024 SonarSource SA
 * sonarlint@sonarsource.com
 * Licensed under the LGPLv3 License. See LICENSE.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

'use strict';

import * as VSCode from 'vscode';
import { BindingService } from './binding';
import { ConnectionSettingsService } from '../settings/connectionsettings';
import {
  BindingSuggestion,
  ListFilesInScopeResponse,
  FolderUriParams,
  FoundFileDto,
  SuggestBindingParams
} from '../lsp/protocol';
import { DEFAULT_CONNECTION_ID, SonarLintDocumentation } from '../commons';
import { DONT_ASK_AGAIN_ACTION } from '../util/showMessage';
import { Uri } from 'vscode';

const AUTOBINDING_THRESHOLD = 1;
const BIND_ACTION = 'Configure Binding';
const CHOOSE_MANUALLY_ACTION = 'Choose Manually';
const SONAR_SCANNER_CONFIG_FILENAME = "sonar-project.properties"
const AUTOSCAN_CONFIG_FILENAME = ".sonarcloud.properties"
export const DO_NOT_ASK_ABOUT_AUTO_BINDING_FOR_WS_FLAG = 'doNotAskAboutAutoBindingForWorkspace';
export const DO_NOT_ASK_ABOUT_AUTO_BINDING_FOR_FOLDER_FLAG = 'doNotAskAboutAutoBindingForFolder';
const CONFIGURE_BINDING_PROMPT_MESSAGE = `There are folders in your workspace that are not bound to any SonarQube/SonarCloud projects.
      Do you want to configure binding?
      [Learn More](${SonarLintDocumentation.CONNECTED_MODE})`;

export class AutoBindingService {
  private static _instance: AutoBindingService;

  static init(
    bindingService: BindingService,
    workspaceState: VSCode.Memento,
    settingsService: ConnectionSettingsService
  ): void {
    AutoBindingService._instance = new AutoBindingService(bindingService, workspaceState, settingsService);
  }

  constructor(
    private readonly bindingService: BindingService,
    private readonly workspaceState: VSCode.Memento,
    private readonly settingsService: ConnectionSettingsService
  ) {}

  static get instance(): AutoBindingService {
    return AutoBindingService._instance;
  }

  async checkConditionsAndAttemptAutobinding(params: SuggestBindingParams) {
    if (!this.isConnectionConfigured()) {
      return;
    }
    if (this.workspaceState.get(DO_NOT_ASK_ABOUT_AUTO_BINDING_FOR_WS_FLAG)) {
      return;
    }
    const bindingSuggestions = params.suggestions;
    if (Object.keys(bindingSuggestions).length > AUTOBINDING_THRESHOLD) {
      await this.askUserBeforeAutoBinding();
    } else {
      this.autoBindAllFolders(bindingSuggestions);
    }
  }

  private autoBindAllFolders(bindingSuggestions: { [folderUri: string]: Array<BindingSuggestion> }) {
    const foldersNotToAutoBound = this.getFoldersThatShouldNotBeAutoBound();
    Object.keys(bindingSuggestions).forEach((folderUri) => {
      const workspaceFolder = VSCode.workspace.getWorkspaceFolder(VSCode.Uri.parse(folderUri));
      if (workspaceFolder && !foldersNotToAutoBound.includes(workspaceFolder.uri.toString())) {
        this.promptToAutoBind(bindingSuggestions[folderUri], workspaceFolder);
      }
    });
  }

  isConnectionConfigured(): boolean {
    const sonarCloudConnections = this.settingsService.getSonarCloudConnections();
    const sonarQubeConnections = this.settingsService.getSonarQubeConnections();
    return sonarCloudConnections.length > 0 || sonarQubeConnections.length > 0;
  }

  private getFoldersThatShouldNotBeAutoBound(): string[] {
    return this.workspaceState.get<string[]>(DO_NOT_ASK_ABOUT_AUTO_BINDING_FOR_FOLDER_FLAG, []);
  }

  async listFilesInFolder(params: FolderUriParams): Promise<ListFilesInScopeResponse> {
    const uri = VSCode.Uri.parse(params.folderUri)
    const foundFiles: Array<FoundFileDto> = await this.listFilesRecursively(uri);
    return { foundFiles };
  }

  private async listFilesRecursively(uri: Uri) {
    try {
      const files = await VSCode.workspace.fs.readDirectory(uri);
      let foundFiles: Array<FoundFileDto> = [];
      for (const [name, type] of files) {
        const fullFileUri = VSCode.Uri.joinPath(uri, name);

        if (type === VSCode.FileType.File) {
          await this.readPropertiesFiles(name, fullFileUri, foundFiles);
        }
        if (type === VSCode.FileType.Directory) {
          const subFiles = await this.listFilesRecursively(fullFileUri);
          foundFiles = foundFiles.concat(subFiles);
        }
      }
      return foundFiles;
    } catch (error) {
      return [];
    }
  }

  private async readPropertiesFiles(name: string, fullFileUri: VSCode.Uri, foundFiles: Array<FoundFileDto>) {
    let content: string = null;
    if (name === AUTOSCAN_CONFIG_FILENAME || name === SONAR_SCANNER_CONFIG_FILENAME) {
      content = (await VSCode.workspace.fs.readFile(fullFileUri)).toString();
    }
    foundFiles.push({ fileName: name, filePath: fullFileUri.fsPath, content });
  }

  async getTargetConnectionForManualBinding() {
    const sonarQubeConnections = this.settingsService.getSonarQubeConnections();
    const sonarCloudConnections = this.settingsService.getSonarCloudConnections();
    let targetConnection;
    if (sonarCloudConnections.length === 0 && sonarQubeConnections.length === 1) {
      targetConnection = {
        label: this.computeItemLabel('SonarQube', sonarQubeConnections[0]),
        description: 'SonarQube',
        connectionId: this.computeConnectionId(sonarQubeConnections[0]),
        contextValue: 'sonarqubeConnection'
      };
    } else if (sonarQubeConnections.length === 0 && sonarCloudConnections.length === 1) {
      targetConnection = {
        label: this.computeItemLabel('SonarCloud', sonarCloudConnections[0]),
        description: 'SonarCloud',
        connectionId: this.computeConnectionId(sonarCloudConnections[0]),
        contextValue: 'sonarcloudConnection'
      };
    } else {
      const connectionNames = [];
      sonarQubeConnections.forEach(c => {
        connectionNames.push({
          label: this.computeItemLabel('SonarQube', c),
          description: 'SonarQube',
          connectionId: this.computeConnectionId(c),
          contextValue: 'sonarqubeConnection'
        });
      });
      sonarCloudConnections.forEach(c => {
        connectionNames.push({
          label: this.computeItemLabel('SonarCloud', c),
          description: 'SonarCloud',
          connectionId: this.computeConnectionId(c),
          contextValue: 'sonarcloudConnection'
        });
      });
      targetConnection = VSCode.window.showQuickPick(connectionNames, {
        title: 'Select Connection to Create Binding for',
        placeHolder: 'For which connection do you want to create project binding?'
      });
    }
    return targetConnection;
  }

  private computeItemLabel(serverType: 'SonarQube' | 'SonarCloud', connection) {
    if (serverType === 'SonarQube') {
      return connection.connectionId ? connection.connectionId : connection.serverUrl;
    }
    return connection.connectionId ? connection.connectionId : connection.organizationKey;
  }

  private computeConnectionId(connection) {
    return connection.connectionId ? connection.connectionId : DEFAULT_CONNECTION_ID;
  }

  async askUserBeforeAutoBinding() {
    return VSCode.window
      .showInformationMessage(
        CONFIGURE_BINDING_PROMPT_MESSAGE,
        BIND_ACTION,
        DONT_ASK_AGAIN_ACTION
      )
      .then(async action => {
        if (action === DONT_ASK_AGAIN_ACTION) {
          this.workspaceState.update(DO_NOT_ASK_ABOUT_AUTO_BINDING_FOR_WS_FLAG, true);
        } else if (action === BIND_ACTION) {
          const targetConnection = await this.getTargetConnectionForManualBinding();
          await this.bindingService.createOrEditBinding(targetConnection.connectionId, targetConnection.contextValue);
        }
      });
  }

  private async promptToAutoBind(bindingSuggestions: BindingSuggestion[], unboundFolder: VSCode.WorkspaceFolder) {
    if (bindingSuggestions.length === 1) {
      const bestBindingSuggestion = bindingSuggestions[0];
      await this.promptToAutoBindSingleOption(bestBindingSuggestion, unboundFolder);
    } else if (bindingSuggestions.length > 1) {
      await this.promptToAutoBindMultiChoice(unboundFolder);
    } else {
      await this.promptToBindManually(unboundFolder);
    }
  }

  private async promptToBindManually(unboundFolder: VSCode.WorkspaceFolder) {
    VSCode.window
      .showInformationMessage(
        CONFIGURE_BINDING_PROMPT_MESSAGE,
        BIND_ACTION,
        DONT_ASK_AGAIN_ACTION
      )
      .then(async action => {
        if (action === DONT_ASK_AGAIN_ACTION) {
          this.workspaceState.update(DO_NOT_ASK_ABOUT_AUTO_BINDING_FOR_FOLDER_FLAG, [
            ...this.getFoldersThatShouldNotBeAutoBound(),
            unboundFolder.uri.toString()
          ]);
        } else if (action === BIND_ACTION) {
          const targetConnection = await this.getTargetConnectionForManualBinding();
          await this.bindingService.createOrEditBinding(targetConnection.connectionId, targetConnection.contextValue);
        }
      });
  }

  private async promptToAutoBindSingleOption(
    bindingSuggestion: BindingSuggestion,
    unboundFolder: VSCode.WorkspaceFolder) {

    const commonMessage =
      `Do you want to bind folder '${unboundFolder.name}' to project '${bindingSuggestion.sonarProjectKey}'`;
    const message =
      this.isBindingSuggestionForSonarCloud(bindingSuggestion)
        ? `${commonMessage} of SonarCloud organization '${bindingSuggestion.connectionId}'?`
        : `${commonMessage} of SonarQube server '${bindingSuggestion.connectionId}'?`;

    const result = await VSCode.window.showInformationMessage(
      `${message}
      [Learn More](${SonarLintDocumentation.CONNECTED_MODE})`,
      BIND_ACTION,
      CHOOSE_MANUALLY_ACTION,
      DONT_ASK_AGAIN_ACTION
    );
    switch (result) {
      case BIND_ACTION:
        await this.bindingService.saveBinding(
          bindingSuggestion.sonarProjectKey, bindingSuggestion.connectionId, unboundFolder);
        break;
      case CHOOSE_MANUALLY_ACTION: {
        const targetConnection = await this.getTargetConnectionForManualBinding();
        await this.bindingService.createOrEditBinding(targetConnection.connectionId, targetConnection.contextValue);
        break;
      }
      case DONT_ASK_AGAIN_ACTION:
        await this.workspaceState.update(DO_NOT_ASK_ABOUT_AUTO_BINDING_FOR_FOLDER_FLAG, [
          ...this.getFoldersThatShouldNotBeAutoBound(),
          unboundFolder.uri.toString()
        ]);
        break;
      default:
        // NOP
        break;
    }
  }

  private isBindingSuggestionForSonarCloud(bindingSuggestion: BindingSuggestion) {
    const sonarCloudConnections = this.settingsService.getSonarCloudConnections();
    return sonarCloudConnections.filter(sc => bindingSuggestion.connectionId === sc.connectionId).length > 0;
  }

  private async promptToAutoBindMultiChoice(unboundFolder: VSCode.WorkspaceFolder) {
    const result = await VSCode.window.showInformationMessage(
      CONFIGURE_BINDING_PROMPT_MESSAGE,
      BIND_ACTION,
      DONT_ASK_AGAIN_ACTION
    );
    switch (result) {
      case BIND_ACTION: {
        const targetConnection = await this.getTargetConnectionForManualBinding();
        await this.bindingService.createOrEditBinding(targetConnection.connectionId, targetConnection.contextValue);
        break;
      }
      case DONT_ASK_AGAIN_ACTION:
        await this.workspaceState.update(DO_NOT_ASK_ABOUT_AUTO_BINDING_FOR_FOLDER_FLAG, [
          ...this.getFoldersThatShouldNotBeAutoBound(),
          unboundFolder.uri.toString()
        ]);
        break;
      default:
        // NOP
        break;
    }
  }
}
