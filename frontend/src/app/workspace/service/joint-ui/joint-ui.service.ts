/**
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import { Injectable } from "@angular/core";
import { OperatorMetadataService } from "../operator-metadata/operator-metadata.service";
import { OperatorSchema } from "../../types/operator-schema.interface";
import { CommentBox, OperatorLink, OperatorPredicate, Point } from "../../types/workflow-common.interface";
import { OperatorState, OperatorStatistics } from "../../types/execute-workflow.interface";
import * as joint from "jointjs";
import { fromEventPattern, Observable } from "rxjs";
import { Coeditor } from "../../../common/type/user";
import { OperatorResultCacheStatus } from "../../types/workflow-websocket.interface";

/**
 * Defines the SVG path for the delete button
 */
export const deleteButtonPath =
  "M14.59 8L12 10.59 9.41 8 8 9.41 10.59 12 8 14.59 9.41 16 12 13.41" +
  " 14.59 16 16 14.59 13.41 12 16 9.41 14.59 8zM12 2C6.47 2 2 6.47 2" +
  " 12s4.47 10 10 10 10-4.47 10-10S17.53 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8z";

/**
 * Defines the HTML SVG element for the delete button and customizes the look
 */
export const deleteButtonSVG = `
  <svg class="delete-button" height="24" width="24">
    <path d="M0 0h24v24H0z" fill="none" pointer-events="visible" />
    <path d="${deleteButtonPath}"/>
    <title>delete operator</title>
  </svg>`;

export const addPortButtonPath = `
<path d="M215.037,36.846c-49.129-49.128-129.063-49.128-178.191,0c-49.127,49.127-49.127,129.063,0,178.19
c24.564,24.564,56.83,36.846,89.096,36.846s64.531-12.282,89.096-36.846C264.164,165.909,264.164,85.973,215.037,36.846z
 M49.574,202.309c-42.109-42.109-42.109-110.626,0-152.735c21.055-21.054,48.711-31.582,76.367-31.582s55.313,10.527,76.367,31.582
c42.109,42.109,42.109,110.626,0,152.735C160.199,244.417,91.683,244.417,49.574,202.309z"/>
<path d="M194.823,116.941h-59.882V57.059c0-4.971-4.029-9-9-9s-9,4.029-9,9v59.882H57.059c-4.971,0-9,4.029-9,9s4.029,9,9,9h59.882
v59.882c0,4.971,4.029,9,9,9s9-4.029,9-9v-59.882h59.882c4.971,0,9-4.029,9-9S199.794,116.941,194.823,116.941z"/>
`;

export const removePortButtonPath = `
<path d="M215.037,36.846c-49.129-49.128-129.063-49.128-178.191,0c-49.127,49.127-49.127,129.063,0,178.19
c24.564,24.564,56.83,36.846,89.096,36.846s64.531-12.282,89.096-36.846C264.164,165.909,264.164,85.973,215.037,36.846z
 M49.574,202.309c-42.109-42.109-42.109-110.626,0-152.735c21.055-21.054,48.711-31.582,76.367-31.582s55.313,10.527,76.367,31.582
c42.109,42.109,42.109,110.626,0,152.735C160.199,244.417,91.683,244.417,49.574,202.309z"/>
<path d="M194.823,116.941H57.059c-4.971,0-9,4.029-9,9s4.029,9,9,9h137.764c4.971,0,9-4.029,9-9S199.794,116.941,194.823,116.941z"
/>`;
export const addInputPortButtonSVG = `
  <svg class="add-input-port-button">
    <g transform="scale(0.075)">
      ${addPortButtonPath}
      <rect x="0" y="0" width="252" height="252" fill="transparent" pointer-events="all"/>
    </g>
    <title>add port</title>
  </svg>
`;

export const removeInputPortButtonSVG = `
  <svg class="remove-input-port-button">
    <g transform="scale(0.075)">
      ${removePortButtonPath}
      <rect x="0" y="0" width="252" height="252" fill="transparent" pointer-events="all"/>
    </g>
    <title>remove port</title>
  </svg>
`;

export const addOutputPortButtonSVG = `
  <svg class="add-output-port-button">
    <g transform="scale(0.075)">
      ${addPortButtonPath}
      <rect x="0" y="0" width="252" height="252" fill="transparent" pointer-events="all"/>
    </g>
    <title>add port</title>
  </svg>
`;

export const removeOutputPortButtonSVG = `
  <svg class="remove-output-port-button">
    <g transform="scale(0.075)">
      ${removePortButtonPath}
      <rect x="0" y="0" width="252" height="252" fill="transparent" pointer-events="all"/>
    </g>
    <title>remove port</title>
  </svg>
`;

/**
 * Defines the SVG for the chat button (message icon)
 * This button allows users to send feedback to agents about this operator
 */
export const chatButtonSVG = `
  <svg class="chat-button" height="20" width="20" viewBox="0 0 24 24">
    <rect x="0" y="0" width="24" height="24" fill="transparent" pointer-events="visible" />
    <path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H6l-2 2V4h16v12z"/>
    <title>Chat with agent about this operator</title>
  </svg>
`;

/**
 * Defines the handle (the square at the end) of the source operator for a link
 */
export const sourceOperatorHandle = "M 0 0 L 0 8 L 8 8 L 8 0 z";

/**
 * Defines the handle (the arrow at the end) of the target operator for a link
 */
export const targetOperatorHandle = "M 12 0 L 0 6 L 12 12 z";

export const operatorReuseCacheTextClass = "texera-operator-result-reuse-text";
export const operatorReuseCacheIconClass = "texera-operator-result-reuse-icon";
export const operatorViewResultIconClass = "texera-operator-view-result-icon";
export const operatorStateClass = "texera-operator-state";
export const operatorCoeditorEditingClass = "texera-operator-coeditor-editing";
export const operatorCoeditorChangedPropertyClass = "texera-operator-coeditor-changed-property";
export const operatorAgentActionProgressClass = "texera-operator-agent-action-progress";

export const operatorIconClass = "texera-operator-icon";
export const operatorNameClass = "texera-operator-name";
export const operatorFriendlyNameClass = "texera-operator-friendly-name";
export const operatorTypeClass = "texera-operator-type";
export const operatorPortMetricsClass = "texera-operator-port-metrics";
const operatorWorkerCountClass = "operator-worker-count";

export const linkPathStrokeColor = "#919191";

/**
 * Extends a basic Joint operator element and adds our own HTML markup.
 * Our own HTML markup includes the SVG element for the delete button,
 *   which will show a red delete button on the top right corner
 */
class TexeraCustomJointElement extends joint.shapes.devs.Model {
  static getMarkup(dynamicInputPorts: boolean, dynamicOutputPorts: boolean): string {
    return `
    <g class="element-node">
      <rect class="body"></rect>
      <image class="${operatorIconClass}"></image>
      <text class="${operatorFriendlyNameClass}"></text>
      <text class="${operatorTypeClass}"></text>
      <text class="${operatorNameClass}"></text>
      <text class="${operatorPortMetricsClass}"></text>
      <text class="${operatorWorkerCountClass}"></text>
      <text class="${operatorStateClass}"></text>
      <text class="${operatorReuseCacheTextClass}"></text>
      <text class="${operatorCoeditorEditingClass}"></text>
      <text class="${operatorCoeditorChangedPropertyClass}"></text>
      <text class="${operatorAgentActionProgressClass}"></text>
      <image class="${operatorViewResultIconClass}"></image>
      <image class="${operatorReuseCacheIconClass}"></image>
      <rect class="boundary"></rect>
      <path class="left-boundary"></path>
      <path class="right-boundary"></path>
      ${deleteButtonSVG}
      ${chatButtonSVG}
      ${dynamicInputPorts ? addInputPortButtonSVG : ""}
      ${dynamicInputPorts ? removeInputPortButtonSVG : ""}
      ${dynamicOutputPorts ? addOutputPortButtonSVG : ""}
      ${dynamicOutputPorts ? removeOutputPortButtonSVG : ""}
    </g>
    `;
  }
}

class TexeraCustomCommentElement extends joint.shapes.devs.Model {
  markup = `<g class = "element-node">
  <rect class = "body"></rect>
  ${deleteButtonSVG}
  <image></image>
  </g>`;
}
/**
 * JointUIService controls the shape of an operator and a link
 *  when they are displayed by JointJS.
 *
 * This service alters the basic JointJS element by:
 *  - setting the ID of the JointJS element to be the same as Texera's OperatorID
 *  - changing the look of the operator box (size, colors, lines, etc..)
 *  - adding input and output ports to the box based on the operator metadata
 *  - changing the SVG element and CSS styles of operators, links, ports, etc..
 *  - adding a new delete button and the callback function of the delete button,
 *      (original JointJS element doesn't have a built-in delete button)
 *
 * @author Henry Chen
 * @author Zuozhi Wang
 */
@Injectable({
  providedIn: "root",
})
export class JointUIService {
  public static readonly DEFAULT_OPERATOR_WIDTH = 60;
  public static readonly DEFAULT_OPERATOR_HEIGHT = 60;
  public static readonly DEFAULT_GROUP_MARGIN = 50;
  public static readonly DEFAULT_GROUP_MARGIN_BOTTOM = 40;
  public static readonly DEFAULT_COMMENT_WIDTH = 32;
  public static readonly DEFAULT_COMMENT_HEIGHT = 32;

  private operatorSchemas: ReadonlyArray<OperatorSchema> = [];

  /** Stores original port label text before expansion, keyed by "operatorId::portId" */
  private savedPortLabels = new Map<string, string>();

  constructor(private operatorMetadataService: OperatorMetadataService) {
    // initialize the operator information
    // subscribe to operator metadata observable
    this.operatorMetadataService.getOperatorMetadata().subscribe(value => (this.operatorSchemas = value.operators));
  }

  /**
   * Gets the JointJS UI Element object based on the operator predicate.
   * A JointJS Element could be added to the JointJS graph to let JointJS display the operator accordingly.
   *
   * The function checks if the operatorType exists in the metadata,
   *  if it doesn't, the program will throw an error.
   *
   * The function returns an element that has our custom style,
   *  which are specified in getCustomOperatorStyleAttrs() and getCustomPortStyleAttrs()
   *
   *
   * @param operator OperatorPredicate, the type of the operator
   * @param point Point, the top-left-originated position of the operator element (relative to JointJS paper, not absolute position)
   *
   * @returns JointJS Element
   */

  public getJointOperatorElement(operator: OperatorPredicate, point: Point): joint.dia.Element {
    // check if the operatorType exists in the operator metadata
    const operatorSchema = this.operatorSchemas.find(op => op.operatorType === operator.operatorType);
    if (operatorSchema === undefined) {
      throw new Error(`operator type ${operator.operatorType} doesn't exist`);
    }

    // construct a custom Texera JointJS operator element
    //   and customize the styles of the operator box and ports
    const operatorElement = new TexeraCustomJointElement({
      position: point,
      size: {
        width: JointUIService.DEFAULT_OPERATOR_WIDTH,
        height: JointUIService.DEFAULT_OPERATOR_HEIGHT,
      },
      attrs: JointUIService.getCustomOperatorStyleAttrs(
        operator,
        operator.customDisplayName ?? operatorSchema.additionalMetadata.userFriendlyName,
        operatorSchema.operatorType,
        operatorSchema.additionalMetadata.userFriendlyName
      ),
      ports: {
        groups: {
          in: { attrs: JointUIService.getCustomPortStyleAttrs() },
          out: { attrs: JointUIService.getCustomPortStyleAttrs() },
        },
      },
      markup: TexeraCustomJointElement.getMarkup(
        operator.dynamicInputPorts ?? false,
        operator.dynamicOutputPorts ?? false
      ),
    });

    // set operator element ID to be operator ID
    operatorElement.set("id", operator.operatorID);
    operatorElement.set("z", 1);

    // set the input ports and output ports based on operator predicate
    operator.inputPorts.forEach(port =>
      operatorElement.addPort({
        group: "in",
        id: port.portID,
        attrs: {
          ".port-label": {
            text: "",
            event: "input-port-label:pointerdown",
          },
        },
        label: {
          position: {
            name: "left",
            args: { x: -5, y: 10 },
          },
        },
      })
    );
    operator.outputPorts.forEach(port =>
      operatorElement.addPort({
        group: "out",
        id: port.portID,
        attrs: {
          ".port-label": {
            text: "",
            event: "output-port-label:pointerdown",
          },
        },
        label: {
          position: {
            name: "right",
            args: { x: 5, y: -10 },
          },
        },
      })
    );

    return operatorElement;
  }

  public changeOperatorStatistics(
    jointPaper: joint.dia.Paper,
    operatorID: string,
    statistics: OperatorStatistics | undefined,
    isSource: boolean,
    isSink: boolean
  ): void {
    if (!statistics) {
      this.changeOperatorState(jointPaper, operatorID, OperatorState.Uninitialized);
      return;
    }

    this.changeOperatorState(jointPaper, operatorID, statistics.operatorState);

    const element = jointPaper.getModelById(operatorID) as joint.shapes.devs.Model;
    const allPorts = element.getPorts();
    const inPorts = allPorts.filter(p => p.group === "in");
    const outPorts = allPorts.filter(p => p.group === "out");

    const inputMetrics = statistics.inputPortMetrics;
    const outputMetrics = statistics.outputPortMetrics;

    const workerCount = statistics.numWorkers ?? 1;
    element.attr(`.${operatorWorkerCountClass}/text`, "#workers: " + String(workerCount));

    // Port labels are managed by agent shape info only — skip execution metrics
    this.changeOperatorState(jointPaper, operatorID, statistics.operatorState);
  }
  public foldOperatorDetails(jointPaper: joint.dia.Paper, operatorID: string): void {
    jointPaper.getModelById(operatorID).attr({
      [`.${operatorStateClass}`]: { visibility: "hidden" },
      [`.${operatorPortMetricsClass}`]: { visibility: "hidden" },
      ".delete-button": { visibility: "hidden" },
      ".chat-button": { visibility: "hidden" },
      ".add-input-port-button": { visibility: "hidden" },
      ".add-output-port-button": { visibility: "hidden" },
      ".remove-input-port-button": { visibility: "hidden" },
      ".remove-output-port-button": { visibility: "hidden" },
    });
  }

  public unfoldOperatorDetails(jointPaper: joint.dia.Paper, operatorID: string): void {
    jointPaper.getModelById(operatorID).attr({
      [`.${operatorStateClass}`]: { visibility: "visible" },
      [`.${operatorPortMetricsClass}`]: { visibility: "visible" },
      ".delete-button": { visibility: "visible" },
      ".chat-button": { visibility: "visible" },
      ".add-input-port-button": { visibility: "visible" },
      ".add-output-port-button": { visibility: "visible" },
      ".remove-input-port-button": { visibility: "visible" },
      ".remove-output-port-button": { visibility: "visible" },
    });

    const element = jointPaper.getModelById(operatorID) as joint.shapes.devs.Model;
    if (!element) {
      return;
    }
  }

  public changeOperatorState(jointPaper: joint.dia.Paper, operatorID: string, operatorState: OperatorState): void {
    let fillColor: string;
    switch (operatorState) {
      case OperatorState.Ready:
        fillColor = "#a6bd37";
        break;
      case OperatorState.Completed:
        fillColor = "green";
        break;
      case OperatorState.Pausing:
      case OperatorState.Paused:
        fillColor = "magenta";
        break;
      case OperatorState.Running:
        fillColor = "orange";
        break;
      default:
        fillColor = "gray";
        break;
    }
    jointPaper.getModelById(operatorID).attr({
      [`.${operatorStateClass}`]: { text: operatorState.toString() },
      [`.${operatorStateClass}`]: { fill: fillColor },
      "rect.body": { stroke: fillColor },
      [`.${operatorPortMetricsClass}`]: { fill: fillColor },
      [`.${operatorWorkerCountClass}`]: { fill: fillColor },
    });
    const element = jointPaper.getModelById(operatorID) as joint.shapes.devs.Model;
    const allPorts = element.getPorts();
    const inPorts = allPorts.filter(p => p.group === "in");
    inPorts.forEach(p => {
      if (p.id != null) {
        element.portProp(p.id, "attrs/.port-label/fill", fillColor);
      }
    });

    const outPorts = allPorts.filter(p => p.group === "out");
    outPorts.forEach(p => {
      if (p.id != null) {
        element.portProp(p.id, "attrs/.port-label/fill", fillColor);
      }
    });
  }

  /**
   * This method will change the operator's color based on the validation status
   *  valid  : default color
   *  invalid: red
   *
   * @param jointPaper
   * @param operatorID
   * @param isOperatorValid
   */
  public changeOperatorColor(jointPaper: joint.dia.Paper, operatorID: string, isOperatorValid: boolean): void {
    if (isOperatorValid) {
      jointPaper.getModelById(operatorID).attr("rect.body/stroke", "#CFCFCF");
    } else {
      jointPaper.getModelById(operatorID).attr("rect.body/stroke", "red");
    }
  }

  public changeOperatorDisableStatus(jointPaper: joint.dia.Paper, operator: OperatorPredicate): void {
    jointPaper.getModelById(operator.operatorID).attr("rect.body/fill", JointUIService.getOperatorFillColor(operator));
  }

  public changeOperatorViewResultStatus(
    jointPaper: joint.dia.Paper,
    operator: OperatorPredicate,
    viewResult?: boolean
  ): void {
    const icon = JointUIService.getOperatorViewResultIcon(operator);
    jointPaper.getModelById(operator.operatorID).attr(`.${operatorViewResultIconClass}/xlink:href`, icon);
  }

  public changeOperatorReuseCacheStatus(
    jointPaper: joint.dia.Paper,
    operator: OperatorPredicate,
    cacheStatus?: OperatorResultCacheStatus
  ): void {
    JointUIService.getOperatorCacheDisplayText(operator, cacheStatus);
    const cacheIcon = JointUIService.getOperatorCacheIcon(operator, cacheStatus);

    jointPaper.getModelById(operator.operatorID).attr(`.${operatorReuseCacheIconClass}/xlink:href`, cacheIcon);
    const icon = JointUIService.getOperatorViewResultIcon(operator);
    jointPaper.getModelById(operator.operatorID).attr(`.${operatorViewResultIconClass}/xlink:href`, icon);
  }

  public changeOperatorJointDisplayName(
    operator: OperatorPredicate,
    jointPaper: joint.dia.Paper,
    displayName: string
  ): void {
    jointPaper.getModelById(operator.operatorID).attr(`.${operatorNameClass}/text`, displayName);
  }

  public getCommentElement(commentBox: CommentBox): joint.dia.Element {
    const basic = new joint.shapes.standard.Rectangle();
    if (commentBox.commentBoxPosition) basic.position(commentBox.commentBoxPosition.x, commentBox.commentBoxPosition.y);
    else basic.position(0, 0);
    basic.resize(120, 50);
    const commentElement = new TexeraCustomCommentElement({
      position: commentBox.commentBoxPosition || { x: 0, y: 0 },
      size: {
        width: JointUIService.DEFAULT_COMMENT_WIDTH,
        height: JointUIService.DEFAULT_COMMENT_HEIGHT,
      },
      attrs: JointUIService.getCustomCommentStyleAttrs(),
    });
    commentElement.set("id", commentBox.commentBoxID);
    return commentElement;
  }
  /**
   * This function converts a Texera source and target OperatorPort to
   *   a JointJS link cell <joint.dia.Link> that could be added to the JointJS.
   *
   * @param link
   * @returns JointJS Link Cell
   */
  public static getJointLinkCell(link: OperatorLink): joint.dia.Link {
    const jointLinkCell = JointUIService.getDefaultLinkCell();
    jointLinkCell.set("source", {
      id: link.source.operatorID,
      port: link.source.portID,
    });
    jointLinkCell.set("target", {
      id: link.target.operatorID,
      port: link.target.portID,
    });
    jointLinkCell.set("id", link.linkID);
    jointLinkCell.set("z", 0);
    return jointLinkCell;
  }

  /**
   * This function will creates a custom JointJS link cell using
   *  custom attributes / styles to display the operator.
   *
   * This function defines the svg properties for each part of link, such as the
   *   shape of the arrow or the link. Other styles are defined in the
   *   "app/workspace/component/workflow-editor/workflow-editor.component.scss".
   *
   * The reason for separating styles in svg and css is that while we can
   *   change the shape of the operators in svg, according to JointJS official
   *   website, https://resources.jointjs.com/tutorial/element-styling ,
   *   CSS properties have higher precedence over SVG attributes.
   *
   * As a result, a separate css/scss file is required to override the default
   * style of the operatorLink.
   *
   * @returns JointJS Link
   */
  public static getDefaultLinkCell(): joint.dia.Link {
    return new joint.dia.Link({
      router: {
        name: "manhattan",
      },
      connector: {
        name: "rounded",
      },
      toolMarkup: `<g class="link-tool">
          <g class="tool-remove" event="tool:remove">
          <circle r="11" />
            <path transform="scale(.8) translate(-16, -16)" d="M24.778,21.419 19.276,15.917 24.777
            10.415 21.949,7.585 16.447,13.087 10.945,7.585 8.117,10.415 13.618,15.917 8.116,21.419
            10.946,24.248 16.447,18.746 21.948,24.248z"/>
            <title>Remove link.</title>
           </g>
         </g>`,
      attrs: {
        ".connection": {
          stroke: linkPathStrokeColor,
          "stroke-width": "2px",
        },
        ".connection-wrap": {
          "stroke-width": "0px",
          // 'display': 'inline'
        },
        ".marker-source": {
          d: sourceOperatorHandle,
          stroke: "none",
          fill: "#919191",
        },
        ".marker-arrowhead-group-source .marker-arrowhead": {
          d: sourceOperatorHandle,
        },
        ".marker-target": {
          d: targetOperatorHandle,
          stroke: "none",
          fill: "#919191",
        },
        ".marker-arrowhead-group-target .marker-arrowhead": {
          d: targetOperatorHandle,
        },
        ".tool-remove": {
          fill: "#D8656A",
          width: 24,
          display: "none",
        },
        ".tool-remove path": {
          d: deleteButtonPath,
        },
        ".tool-remove circle": {},
      },
    });
  }

  /**
   * This function changes the default svg of the operator ports.
   * It hides the port label that will display 'out/in' beside the operators.
   *
   * @returns the custom attributes of the ports
   */
  public static getCustomPortStyleAttrs(): joint.attributes.SVGAttributes {
    return {
      ".port-body": {
        fill: "#A0A0A0",
        r: 5,
        stroke: "none",
      },
      ".port-label": {
        visibility: "visible",
        event: "input-label:evt",
        dblclick: "input-label:dbclick",
        pointerdblclick: "input-label:pointerdblclick",
        ref: ".port-body",
        "ref-y": 0.5,
        "y-alignment": "middle",
      },
    };
  }

  /**
   * This function create a custom svg style for the operator
   * @returns the custom attributes of the tooltip.
   */
  public static getCustomOperatorStatusTooltipStyleAttrs(): joint.shapes.devs.ModelSelectors {
    return {
      "element-node": {
        style: { "pointer-events": "none" },
      },
      polygon: {
        fill: "#FFFFFF",
        "follow-scale": true,
        stroke: "purple",
        "stroke-width": "2",
        rx: "5px",
        ry: "5px",
        refPoints: "0,30 150,30 150,120 85,120 75,150 65,120 0,120",
        display: "none",
        style: { "pointer-events": "none" },
      },
      "#operatorCount": {
        fill: "#595959",
        "font-size": "12px",
        ref: "polygon",
        "y-alignment": "middle",
        "x-alignment": "left",
        "ref-x": 0.05,
        "ref-y": 0.2,
        display: "none",
        style: { "pointer-events": "none" },
      },
    };
  }

  /**
   * This function creates a custom svg style for the operator.
   * This function also makes the delete button defined above to emit the delete event that will
   *   be captured by JointJS paper using event name *element:delete*
   *
   * @param operator
   * @param operatorDisplayName the name of the operator that will display on the UI
   * @param operatorType
   * @param operatorFriendlyName
   * @returns the custom attributes of the operator
   */
  public static getCustomOperatorStyleAttrs(
    operator: OperatorPredicate,
    operatorDisplayName: string,
    operatorType: string,
    operatorFriendlyName: string
  ): joint.shapes.devs.ModelSelectors {
    return {
      ".texera-operator-coeditor-editing": {
        text: "",
        "font-size": "14px",
        "font-weight": "bold",
        visibility: "hidden",
        "ref-x": -50,
        "ref-y": 100,
        ref: "rect.body",
        "y-alignment": "middle",
        "x-alignment": "start",
      },
      ".texera-operator-coeditor-changed-property": {
        text: "",
        "font-weight": "bold",
        "font-size": "14px",
        visibility: "hidden",
        "ref-x": 0.5,
        "ref-y": 120,
        ref: "rect.body",
        "y-alignment": "middle",
        "x-alignment": "middle",
      },
      ".texera-operator-agent-action-progress": {
        text: "",
        "font-size": "11px",
        "font-weight": "bold",
        "font-family": "'Inter', 'SF Pro Display', -apple-system, sans-serif",
        visibility: "hidden",
        "ref-x": 0.5, // Center horizontally
        "ref-y": 95, // Below the operator name
        ref: "rect.body",
        "text-anchor": "middle",
        "x-alignment": "middle",
        "y-alignment": "middle",
      },
      ".texera-operator-state": {
        text: "",
        "font-size": "14px",
        visibility: "hidden",
        "ref-x": 0.5,
        "ref-y": 100,
        ref: "rect.body",
        "y-alignment": "middle",
        "x-alignment": "middle",
      },
      ".texera-operator-abbreviated-count": {
        text: "",
        fill: "green",
        "font-size": "14px",
        visibility: "visible",
        "ref-x": 0.5,
        "ref-y": -30,
        ref: "rect.body",
        "y-alignment": "middle",
        "x-alignment": "middle",
      },
      ".texera-operator-port-metrics": {
        text: "",
        fill: "green",
        "font-size": "14px",
        visibility: "hidden",
        "ref-x": 0.5,
        "ref-y": -70,
        ref: "rect.body",
        "y-alignment": "middle",
        "x-alignment": "middle",
      },
      ".texera-operator-processed-count": {
        text: "",
        fill: "green",
        "font-size": "14px",
        visibility: "hidden",
        "ref-x": 0.5,
        "ref-y": -50,
        ref: "rect.body",
        "y-alignment": "middle",
        "x-alignment": "middle",
      },
      ".texera-operator-output-count": {
        text: "",
        fill: "green",
        "font-size": "14px",
        visibility: "hidden",
        "ref-x": 0.5,
        "ref-y": -30,
        ref: "rect.body",
        "y-alignment": "middle",
        "x-alignment": "middle",
      },
      "rect.body": {
        fill: JointUIService.getOperatorFillColor(operator),
        "follow-scale": true,
        stroke: "red",
        "stroke-width": "2",
        rx: "5px",
        ry: "5px",
      },
      "rect.boundary": {
        fill: "rgba(0, 0, 0, 0)",
        width: this.DEFAULT_OPERATOR_WIDTH + 20,
        height: this.DEFAULT_OPERATOR_HEIGHT + 20,
        ref: "rect.body",
        "ref-x": -10,
        "ref-y": -10,
      },
      "path.right-boundary": {
        ref: "rect.body",
        d: "M 20 80 C 0 60 0 20 20 0",
        stroke: "rgba(0,0,0,0)",
        "stroke-width": "10",
        fill: "transparent",
        "ref-x": 70,
        "ref-y": -10,
      },
      "path.left-boundary": {
        ref: "rect.body",
        d: "M 0 80 C 20 60 20 20 0 0",
        stroke: "rgba(0,0,0,0)",
        "stroke-width": "10",
        fill: "transparent",
        "ref-x": -30,
        "ref-y": -10,
      },
      ".texera-operator-name": {
        text: operatorDisplayName,
        fill: "#595959",
        "font-size": "14px",
        "ref-x": 0.5,
        "ref-y": this.DEFAULT_OPERATOR_HEIGHT + 8,
        ref: "rect.body",
        "y-alignment": "top",
        "x-alignment": "middle",
        cursor: "pointer",
        event: "element:name:pointerclick",
        textWrap: {
          width: 250,
          height: 80,
        },
      },
      ".texera-operator-friendly-name": {
        text: operator.operatorID,
        fill: "#888888",
        "font-size": "10px",
        "ref-x": 0.5,
        "ref-y": -12,
        ref: "rect.body",
        "y-alignment": "middle",
        "x-alignment": "middle",
      },
      [`.${operatorTypeClass}`]: {
        text: operatorFriendlyName,
        fill: "#888888",
        "font-size": "9px",
        "ref-x": 0.5,
        "ref-y": 52,
        ref: "rect.body",
        "y-alignment": "middle",
        "x-alignment": "middle",
      },
      [`.${operatorWorkerCountClass}`]: {
        "ref-x": -5,
        "ref-y": -35,
      },
      ".delete-button": {
        x: 60,
        y: -20,
        cursor: "pointer",
        fill: "#D8656A",
        event: "element:delete",
        visibility: "hidden",
      },
      ".chat-button": {
        x: 85,
        y: -20,
        cursor: "pointer",
        fill: "#1890ff",
        event: "element:chat",
        visibility: "hidden",
      },
      ".add-input-port-button": {
        x: -25,
        y: 65,
        cursor: "pointer",
        fill: "#565656",
        event: "element:add-input-port",
        visibility: "hidden",
      },
      ".remove-input-port-button": {
        x: -25,
        y: 85,
        cursor: "pointer",
        fill: "#565656",
        event: "element:remove-input-port",
        visibility: "hidden",
      },
      ".add-output-port-button": {
        x: 65,
        y: 65,
        cursor: "pointer",
        fill: "#565656",
        event: "element:add-output-port",
        visibility: "hidden",
      },
      ".remove-output-port-button": {
        x: 65,
        y: 85,
        cursor: "pointer",
        fill: "#565656",
        event: "element:remove-output-port",
        visibility: "hidden",
      },
      ".texera-operator-icon": {
        "xlink:href": "assets/operator_images/" + operatorType + ".png",
        width: 35,
        height: 35,
        "ref-x": 0.5,
        "ref-y": 0.5,
        ref: "rect.body",
        "x-alignment": "middle",
        "y-alignment": "middle",
      },
      ".texera-operator-result-reuse-text": {
        text: JointUIService.getOperatorCacheDisplayText(operator) === "" ? "" : "cache",
        fill: "#595959",
        "font-size": "14px",
        visible: true,
        "ref-x": 80,
        "ref-y": 60,
        ref: "rect.body",
        "y-alignment": "middle",
        "x-alignment": "middle",
      },
      ".texera-operator-result-reuse-icon": {
        "xlink:href": JointUIService.getOperatorCacheIcon(operator),
        width: 40,
        height: 40,
        "ref-x": 75,
        "ref-y": 50,
        ref: "rect.body",
        "x-alignment": "middle",
        "y-alignment": "middle",
      },
      ".texera-operator-view-result-icon": {
        "xlink:href": JointUIService.getOperatorViewResultIcon(operator),
        width: 20,
        height: 20,
        "ref-x": 49,
        "ref-y": 9,
        ref: "rect.body",
        "x-alignment": "middle",
        "y-alignment": "middle",
      },
    };
  }

  public static getOperatorFillColor(operator: OperatorPredicate): string {
    const isDisabled = operator.isDisabled ?? false;
    return isDisabled ? "#E0E0E0" : "#FFFFFF";
  }

  public static getOperatorCacheDisplayText(
    operator: OperatorPredicate,
    cacheStatus?: OperatorResultCacheStatus
  ): string {
    if (cacheStatus === undefined || !operator.markedForReuse) {
      return "";
    }
    return cacheStatus;
  }

  public static getOperatorCacheIcon(operator: OperatorPredicate, cacheStatus?: OperatorResultCacheStatus): string {
    if (!operator.markedForReuse) {
      return "";
    }
    if (cacheStatus === "cache valid") {
      return "assets/svg/operator-reuse-cache-valid.svg";
    } else {
      return "assets/svg/operator-reuse-cache-invalid.svg";
    }
  }

  public static getOperatorViewResultIcon(operator: OperatorPredicate): string {
    if (operator.viewResult) {
      return "assets/svg/operator-view-result.svg";
    } else {
      return "";
    }
  }

  public static getCustomCommentStyleAttrs(): joint.shapes.devs.ModelSelectors {
    return {
      rect: {
        fill: "#F2F4F5",
        "follow-scale": true,
        stroke: "#CED4D9",
        "stroke-width": "0",
        rx: "5px",
        ry: "5px",
      },
      image: {
        "xlink:href": "assets/operator_images/icons8-chat_bubble.png",
        width: 32,
        height: 32,
        "ref-x": 0.5,
        "ref-y": 0.5,
        ref: "rect",
        "x-alignment": "middle",
        "y-alignment": "middle",
      },
      ".delete-button": {
        x: 22,
        y: -16,
        cursor: "pointer",
        fill: "#D8656A",
        event: "element:delete",
      },
    };
  }

  public static getJointUserPointerCell(coeditor: Coeditor, position: Point, color: string): joint.dia.Element {
    const userCursor = new joint.shapes.standard.Circle({
      id: this.getJointUserPointerName(coeditor),
    });
    userCursor.resize(15, 15);
    userCursor.position(position.x, position.y);
    userCursor.attr("body/fill", color);
    userCursor.attr("body/stroke", color);
    userCursor.attr("text", {
      text: coeditor.name,
      "ref-x": 15,
      "ref-y": 20,
      stroke: coeditor.color,
    });
    return userCursor;
  }

  public static getJointUserPointerName(coeditor: Coeditor) {
    return "pointer_" + coeditor.clientId;
  }

  /**
   * Shows agent action labels (viewed/added/modified) on operators.
   * Displays bold agent name and action type as text below the operator.
   * @param jointPaper The JointJS paper
   * @param operatorID The operator ID to show labels on
   * @param actionType The type of action: "viewed", "added", or "modified"
   * @param agentName The name of the agent performing the action
   */
  public showAgentActionLabel(
    jointPaper: joint.dia.Paper,
    operatorID: string,
    actionType: "viewed" | "added" | "modified",
    agentName: string = "Agent"
  ): void {
    const element = jointPaper.getModelById(operatorID);
    if (!element) {
      return;
    }

    // Format: "AgentName: action" with bold styling
    const labelText = `${agentName}: ${actionType}`;

    element.attr({
      [`.${operatorAgentActionProgressClass}`]: {
        text: labelText,
        fill: "#52c41a",
        "font-weight": "bold",
        visibility: "visible",
      },
    });
  }

  /**
   * Hides agent action labels on operators.
   * @param jointPaper The JointJS paper
   * @param operatorID The operator ID to hide labels on
   */
  public hideAgentActionLabel(jointPaper: joint.dia.Paper, operatorID: string): void {
    const element = jointPaper.getModelById(operatorID);
    if (!element) {
      return;
    }

    element.attr({
      [`.${operatorAgentActionProgressClass}`]: {
        text: "",
        visibility: "hidden",
      },
    });
  }

  /**
   * Extract key properties from an operator for display in the expanded view.
   */
  public static extractOperatorProperties(operator: OperatorPredicate): Array<{ label: string; value: string }> {
    const props = operator.operatorProperties as Record<string, any>;
    const type = operator.operatorType;

    switch (type) {
      case "Projection": {
        const items: Array<{ label: string; value: string }> = [];
        items.push({ label: "Mode", value: props["isDrop"] ? "Drop" : "Keep" });
        const attrs = props["attributes"] as Array<{ originalAttribute?: string; alias?: string }> | undefined;
        if (attrs && attrs.length > 0) {
          const names = attrs
            .map(a => (a.alias && a.alias !== a.originalAttribute ? `${a.originalAttribute}→${a.alias}` : a.originalAttribute || ""))
            .filter(Boolean);
          items.push({ label: "Attributes", value: names.join(", ") || "(none)" });
        }
        return items;
      }
      case "Sort": {
        const attrs = props["attributes"] as Array<{ attribute?: string; sortPreference?: string }> | undefined;
        if (attrs && attrs.length > 0) {
          const spec = attrs.map(a => `${a.attribute || ""} ${a.sortPreference === "DESC" ? "↓" : "↑"}`).join(", ");
          return [{ label: "Sort By", value: spec }];
        }
        return [];
      }
      case "Limit":
        return props["limit"] !== undefined ? [{ label: "Limit", value: String(props["limit"]) }] : [];
      case "CSVScanSource":
      case "CSVFileScan": {
        const items: Array<{ label: string; value: string }> = [];
        if (props["fileName"]) {
          const parts = String(props["fileName"]).split("/");
          items.push({ label: "File", value: parts[parts.length - 1] || props["fileName"] });
        }
        if (props["customDelimiter"]) {
          const d = props["customDelimiter"];
          items.push({ label: "Delimiter", value: d === "," ? "comma" : d === "\t" ? "tab" : `"${d}"` });
        }
        return items;
      }
      case "HashJoin": {
        const items: Array<{ label: string; value: string }> = [];
        if (props["buildAttributeName"] && props["probeAttributeName"]) {
          items.push({ label: "Join", value: `${props["buildAttributeName"]} = ${props["probeAttributeName"]}` });
        }
        if (props["joinType"]) {
          items.push({ label: "Type", value: String(props["joinType"]).toLowerCase().replace(/_/g, " ") });
        }
        return items;
      }
      case "Aggregate": {
        const items: Array<{ label: string; value: string }> = [];
        const groupByKeys = props["groupByKeys"] as string[] | undefined;
        if (groupByKeys && groupByKeys.length > 0) {
          items.push({ label: "Group By", value: groupByKeys.join(", ") });
        }
        const aggs = props["aggregations"] as Array<{
          aggFunction?: string;
          attribute?: string;
          "result attribute"?: string;
        }> | undefined;
        if (aggs && aggs.length > 0) {
          for (const a of aggs) {
            const fn = a.aggFunction || "?";
            const attr = a.attribute || "?";
            const resultAttr = a["result attribute"];
            const desc = resultAttr ? `${fn}(${attr}) → ${resultAttr}` : `${fn}(${attr})`;
            items.push({ label: fn, value: desc });
          }
        }
        return items;
      }
      case "PythonUDFV2":
      case "PythonUDFSourceV2":
      case "DualInputPortsPythonUDFV2":
      case "PythonTableUDF":
      case "DataProcessing":
      case "DataLoading": {
        const code = props["code"] as string | undefined;
        if (code) {
          // Special marker: label "__code__" signals the renderer to use a code block
          return [{ label: "__code__", value: code }];
        }
        return [];
      }
      default: {
        const items: Array<{ label: string; value: string }> = [];
        for (const key of Object.keys(props).slice(0, 3)) {
          const val = props[key];
          if (val !== undefined && val !== null && typeof val !== "object") {
            const label = key.replace(/([A-Z])/g, " $1").replace(/^./, s => s.toUpperCase()).trim();
            items.push({ label, value: String(val) });
          }
        }
        return items;
      }
    }
  }

  /**
   * Apply the expanded detail layout to an operator on the paper.
   * This is the default layout — no toggle needed.
   */
  public applyExpandedLayout(
    jointPaper: joint.dia.Paper,
    operatorID: string,
    operator: OperatorPredicate
  ): void {
    const properties = JointUIService.extractOperatorProperties(operator);
    this.expandOperatorWithResults(jointPaper, operatorID, undefined, properties);
  }

  /**
   * Apply expanded layout to an operator, optionally with agent result summary.
   * Layout:
   *   In/Out info written to port labels (when summary provided)
   *   Inside the box:
   *     Left: [icon] [type]   Right: key properties (full text, no truncation)
   *   Width is flexible based on content.
   */
  public expandOperatorWithResults(
    jointPaper: joint.dia.Paper,
    operatorID: string,
    summary?: {
      state: string;
      inputTuples: number;
      outputTuples: number;
      inputPortShapes?: { portIndex: number; rows: number; columns: number }[];
      outputColumns?: number;
      error?: string;
    },
    properties?: Array<{ label: string; value: string }>
  ): void {
    const element = jointPaper.getModelById(operatorID) as joint.shapes.devs.Model;
    if (!element) return;

    const svgNs = "http://www.w3.org/2000/svg";
    const view = jointPaper.findViewByModel(operatorID);
    if (!view) return;
    const groupEl = view.el.querySelector(".element-node") || view.el;

    // Remove any previously injected result elements
    groupEl.querySelectorAll(".result-info").forEach((el: Element) => el.remove());

    const fontSize = 10;
    const fontFamily = "'Inter', -apple-system, sans-serif";
    const textColor = "#595959";
    const headerColor = "#262626";
    const padding = 8;
    const lineH = 13;

    // --- Helper to add SVG text, returns the element for measurement ---
    const addText = (
      x: number,
      y: number,
      parts: Array<{ text: string; fill: string; bold?: boolean }>,
      anchor?: string
    ): SVGTextElement => {
      const textEl = document.createElementNS(svgNs, "text");
      textEl.classList.add("result-info");
      textEl.setAttribute("x", String(x));
      textEl.setAttribute("y", String(y));
      textEl.setAttribute("font-size", String(fontSize));
      textEl.setAttribute("font-family", fontFamily);
      if (anchor) textEl.setAttribute("text-anchor", anchor);
      for (const part of parts) {
        const tspan = document.createElementNS(svgNs, "tspan");
        tspan.setAttribute("fill", part.fill);
        if (part.bold) tspan.setAttribute("font-weight", "600");
        tspan.textContent = part.text;
        textEl.appendChild(tspan);
      }
      groupEl.appendChild(textEl);
      return textEl;
    };

    // --- Write in/out info to port labels when agent summary is available ---
    if (summary) {
      const allPorts = element.getPorts();
      const inPorts = allPorts.filter(p => p.group === "in");
      const outPorts = allPorts.filter(p => p.group === "out");

      inPorts.forEach((portDef, idx) => {
        if (!portDef.id) return;
        let labelText: string;
        if (summary.inputPortShapes && summary.inputPortShapes.length > 0) {
          const ps = summary.inputPortShapes.find(s => s.portIndex === idx) ?? summary.inputPortShapes[0];
          labelText = `(${ps.rows}, ${ps.columns})`;
        } else {
          labelText = `(${summary.inputTuples})`;
        }
        element.portProp(portDef.id, "attrs/.port-label/text", labelText);
        element.portProp(portDef.id, "attrs/.port-label/fill", "#52c41a");
      });

      outPorts.forEach(portDef => {
        if (!portDef.id) return;
        const outVal =
          summary.outputColumns !== undefined
            ? `(${summary.outputTuples}, ${summary.outputColumns})`
            : `(${summary.outputTuples})`;
        element.portProp(portDef.id, "attrs/.port-label/text", outVal);
        element.portProp(portDef.id, "attrs/.port-label/fill", "#52c41a");
      });
    }

    // --- Layout constants ---
    const iconSize = 30;
    const pad = 6; // inner padding
    const charW = 5; // approx character width at 10px font
    const codeCharW = 6.02; // approx character width for monospace 9px font
    const typeFontSize = 7;
    const typeCharW = 3.5; // approx character width at 7px font
    const typeText = element.attr(`.${operatorTypeClass}/text`) || "";
    const iconTypeGap = 1; // minimal gap between icon bottom and type text baseline
    const leftGroupH = iconSize + iconTypeGap + typeFontSize; // total height of icon+type group

    // Left column width: max of icon width and type text width, plus left padding
    const typeTextWidth = typeText.length * typeCharW;
    const leftContentWidth = Math.max(iconSize, typeTextWidth);
    const leftColumnEnd = pad + leftContentWidth; // right edge of left column

    // Detect code block mode (PythonUDF)
    const props = properties ?? [];
    const isCodeBlock = props.length === 1 && props[0].label === "__code__";
    const codeContent = isCodeBlock ? props[0].value : "";
    const regularProps = isCodeBlock ? [] : props;

    // Right column: compute width
    const gap = 6;
    const propX = leftColumnEnd + gap;
    let rightContentWidth = 0;

    if (isCodeBlock) {
      const codeLines = codeContent.split("\n");
      const maxLineLen = Math.max(...codeLines.map(l => l.length), 10);
      rightContentWidth = maxLineLen * codeCharW + 12; // 12 for code block padding
    } else {
      for (const prop of regularProps) {
        rightContentWidth = Math.max(rightContentWidth, (prop.label.length + 2 + prop.value.length) * charW);
      }
    }
    if (summary?.error) {
      rightContentWidth = Math.max(rightContentWidth, summary.error.length * charW);
    }

    const minWidth = JointUIService.DEFAULT_OPERATOR_WIDTH;
    const ew = Math.max(minWidth, propX + rightContentWidth + pad);

    // --- Compute box height ---
    let propBottomY = pad;
    if (isCodeBlock) {
      const codeLines = codeContent.split("\n");
      const codeFontSize = 9;
      const codeLineH = codeFontSize + 2;
      propBottomY += codeLines.length * codeLineH + 8; // 8 for code block padding
    } else if (regularProps.length > 0) {
      for (const prop of regularProps) {
        propBottomY += lineH;
      }
    }
    if (summary?.error) {
      propBottomY += lineH;
    }
    propBottomY += pad;

    const minH = leftGroupH + pad * 2; // minimum height to fit icon+type with padding
    const eh = Math.max(propBottomY, minH);

    // --- Vertically center icon+type group within the box ---
    const groupTopY = (eh - leftGroupH) / 2;
    const iconTopY = groupTopY + iconSize / 2; // ref-y needs icon center, not top edge
    const typeLabelY = groupTopY + iconSize + iconTypeGap + typeFontSize; // text baseline

    // Type label below icon, left-aligned, smaller font
    const typeEl = addText(pad, typeLabelY, [
      { text: typeText, fill: textColor, bold: false },
    ]);
    typeEl.setAttribute("font-size", String(typeFontSize));

    // --- Render right side content ---
    if (isCodeBlock) {
      // Render Python code block using foreignObject for HTML-based syntax highlighting
      const codeBlockWidth = ew - propX - pad + 2;
      const codeBlockHeight = eh - pad * 2;
      const fo = document.createElementNS(svgNs, "foreignObject");
      fo.classList.add("result-info");
      fo.setAttribute("x", String(propX));
      fo.setAttribute("y", String(pad));
      fo.setAttribute("width", String(codeBlockWidth));
      fo.setAttribute("height", String(codeBlockHeight));

      const div = document.createElement("div");
      div.style.cssText = `
        width: 100%; height: 100%; overflow: hidden;
        background: transparent; padding: 2px 4px;
        box-sizing: border-box;
      `;

      const pre = document.createElement("pre");
      pre.style.cssText = `
        margin: 0; padding: 0; font-family: 'Menlo', 'Monaco', 'Courier New', monospace;
        font-size: 9px; line-height: 11px; white-space: pre; color: #333;
      `;
      pre.innerHTML = JointUIService.highlightPython(codeContent);
      div.appendChild(pre);
      fo.appendChild(div);
      groupEl.appendChild(fo);
    } else {
      // Regular properties
      let curY = pad;
      if (regularProps.length > 0) {
        for (const prop of regularProps) {
          curY += lineH;
          addText(propX, curY, [
            { text: `${prop.label}: `, fill: textColor },
            { text: prop.value, fill: headerColor, bold: true },
          ]);
        }
      }

      // Error below properties
      if (summary?.error) {
        curY += lineH;
        addText(propX, curY, [{ text: summary.error, fill: "#ff4d4f" }]);
      }
    }

    // --- Resize element ---
    element.resize(ew, eh);

    // --- Reposition controls for new size ---
    element.attr({
      "rect.boundary": { width: ew + 20, height: eh + 20 },
      ".delete-button": { x: ew, y: -20 },
      ".chat-button": { x: ew + 25, y: -20 },
      ".add-input-port-button": { x: -25, y: eh + 5 },
      ".remove-input-port-button": { x: -25, y: eh + 25 },
      ".add-output-port-button": { x: ew + 5, y: eh + 5 },
      ".remove-output-port-button": { x: ew + 5, y: eh + 25 },
      ".texera-operator-icon": {
        width: iconSize,
        height: iconSize,
        "ref-x": pad,       // left edge at padding
        "ref-y": iconTopY,  // top edge at padding
        "x-alignment": "none",
      },
      ".texera-operator-friendly-name": {
        // Keep operator ID above the box
        visibility: "visible",
        "ref-x": 0.5,
        "ref-y": -12,
        "x-alignment": "middle",
        "text-anchor": "middle",
        fill: "#888888",
        "font-size": "10px",
        "font-weight": "normal",
      },
      [`.${operatorTypeClass}`]: {
        visibility: "hidden",
      },
      ".texera-operator-name": {
        "ref-x": 0.5,
        "ref-y": eh + 8,
        "x-alignment": "middle",
        "y-alignment": "top",
      },
      [`.${operatorStateClass}`]: { visibility: "hidden" },
    });
  }

  /**
   * Basic Python syntax highlighting. Returns HTML with colored spans.
   */
  private static highlightPython(code: string): string {
    const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

    const keywords = new Set([
      "def", "class", "return", "if", "elif", "else", "for", "while", "in", "not", "and", "or",
      "import", "from", "as", "try", "except", "finally", "raise", "with", "yield", "lambda",
      "pass", "break", "continue", "is", "None", "True", "False", "self", "async", "await",
    ]);

    const builtins = new Set([
      "print", "len", "range", "int", "str", "float", "list", "dict", "tuple", "set",
      "type", "isinstance", "enumerate", "zip", "map", "filter", "sorted", "reversed",
      "open", "super", "property", "staticmethod", "classmethod",
    ]);

    return code.split("\n").map(line => {
      const escaped = escape(line);
      let result = "";
      let i = 0;
      while (i < escaped.length) {
        // Comments
        if (escaped[i] === "#") {
          result += `<span style="color:#6a737d">${escaped.slice(i)}</span>`;
          break;
        }
        // Strings
        if (escaped[i] === "'" || escaped[i] === '"') {
          const quote = escaped[i];
          let j = i + 1;
          while (j < escaped.length && escaped[j] !== quote) {
            if (escaped[j] === "\\") j++;
            j++;
          }
          j++;
          result += `<span style="color:#032f62">${escaped.slice(i, j)}</span>`;
          i = j;
          continue;
        }
        // Words
        if (/[a-zA-Z_]/.test(escaped[i])) {
          let j = i;
          while (j < escaped.length && /[a-zA-Z0-9_]/.test(escaped[j])) j++;
          const word = escaped.slice(i, j);
          if (keywords.has(word)) {
            result += `<span style="color:#d73a49">${word}</span>`;
          } else if (builtins.has(word)) {
            result += `<span style="color:#6f42c1">${word}</span>`;
          } else {
            result += word;
          }
          i = j;
          continue;
        }
        // Numbers
        if (/[0-9]/.test(escaped[i])) {
          let j = i;
          while (j < escaped.length && /[0-9.]/.test(escaped[j])) j++;
          result += `<span style="color:#005cc5">${escaped.slice(i, j)}</span>`;
          i = j;
          continue;
        }
        // Decorators
        if (escaped[i] === "@") {
          let j = i + 1;
          while (j < escaped.length && /[a-zA-Z0-9_.]/.test(escaped[j])) j++;
          result += `<span style="color:#6f42c1">${escaped.slice(i, j)}</span>`;
          i = j;
          continue;
        }
        result += escaped[i];
        i++;
      }
      return result;
    }).join("\n");
  }

  /**
   * Collapse an operator back to its default size, removing result info.
   */
  public collapseOperator(jointPaper: joint.dia.Paper, operatorID: string): void {
    const element = jointPaper.getModelById(operatorID) as joint.shapes.devs.Model;
    if (!element) return;

    const dw = JointUIService.DEFAULT_OPERATOR_WIDTH;
    const dh = JointUIService.DEFAULT_OPERATOR_HEIGHT;

    // Restore original size
    element.resize(dw, dh);

    // Restore boundary, buttons, and label positions
    element.attr({
      "rect.boundary": { width: dw + 20, height: dh + 20 },
      ".delete-button": { x: 60, y: -20 },
      ".chat-button": { x: 85, y: -20 },
      ".add-input-port-button": { x: -25, y: 65 },
      ".remove-input-port-button": { x: -25, y: 85 },
      ".add-output-port-button": { x: 65, y: 65 },
      ".remove-output-port-button": { x: 65, y: 85 },
      ".texera-operator-icon": {
        width: 35,
        height: 35,
        "ref-x": 0.5,
        "ref-y": 0.5,
      },
      ".texera-operator-friendly-name": {
        // Restore operator ID text
        text: operatorID,
        visibility: "visible",
        "ref-x": 0.5,
        "ref-y": -12,
        "x-alignment": "middle",
        "text-anchor": "middle",
        fill: "#888888",
        "font-size": "10px",
        "font-weight": "normal",
      },
      [`.${operatorTypeClass}`]: {
        visibility: "visible",
        "ref-x": 0.5,
        "ref-y": 52,
        "x-alignment": "middle",
        "text-anchor": "middle",
        fill: "#888888",
        "font-size": "9px",
      },
      ".texera-operator-name": {
        "ref-x": 0.5,
        "ref-y": dh + 8,
        "x-alignment": "middle",
        "y-alignment": "top",
      },
      [`.${operatorStateClass}`]: { visibility: "hidden" },
    });

    // Restore port labels from saved state
    const allPorts = element.getPorts();
    for (const portDef of allPorts) {
      if (portDef.id) {
        const key = `${operatorID}::${portDef.id}`;
        const originalText = this.savedPortLabels.get(key) ?? "";
        this.savedPortLabels.delete(key);
        element.portProp(portDef.id, "attrs/.port-label/text", originalText);
        element.portProp(portDef.id, "attrs/.port-label/fill", "#000");
      }
    }

    // Remove injected result info elements
    const view = jointPaper.findViewByModel(operatorID);
    if (!view) return;
    const groupEl = view.el.querySelector(".element-node") || view.el;
    groupEl.querySelectorAll(".result-info").forEach((el: Element) => el.remove());
  }

  /**
   * Collapse all operators back to default size.
   */
  public collapseAllOperators(jointPaper: joint.dia.Paper, operatorIDs: string[]): void {
    for (const opId of operatorIDs) {
      this.collapseOperator(jointPaper, opId);
    }
  }
}

export function fromJointPaperEvent<T extends keyof joint.dia.Paper.EventMap = keyof joint.dia.Paper.EventMap>(
  paper: joint.dia.Paper,
  eventName: T,
  context?: any
): Observable<Parameters<joint.dia.Paper.EventMap[T]>> {
  return fromEventPattern(
    handler => paper.on(eventName, handler, context), // addHandler
    (handler, signal) => paper.off(eventName as string, handler, context) // removeHandler
  );
}
