export type GetValueCall = {path: string};
export type SetValueCall = {path: string, value: boolean | number | string};
export type AddObjectCall = {path: string};
export type DeleteObjectCall = {path: string};
export type FunctionCall = ({
  type: 'getValue';
  called: GetValueCall;
} | {
  type: 'setValue';
  called: SetValueCall;
} | { 
  type: 'addObject';
  called: AddObjectCall;
} | {
  type: 'deleteObject';
  called: DeleteObjectCall;
}) & {__varType: 'FunctionCall'};
export type FunctionReturnValue = {
  type: 'getValue' | 'setValue' | 'addObject' | 'deleteObject';
  path: string;
  value: number | boolean | string | undefined;
} & {__varType: 'FunctionReturnValue'};

/**
 * This is a map to undo the revision logic from genie. It stores the "revision"
 * like value. It is basically an array of objects, each object is a map of the
 * path (TR-069 parameter path) and the value in that iteration.
 * 
 * Each setValue, addObject or deleteObject will increment the revision.
 * 
 * When getting a value, it will return the value of the latest revision that
 * got/changed this value, otherwise it will return undefined.
 */
export class IterationMapCache {
  private declare currentRevision: number;
  private declare callStack: (FunctionCall | FunctionReturnValue)[];

  public constructor() {
    this.currentRevision = 0;
    this.callStack = [];
  }

  /**
   * Increment the revision. This should be called after each getValue,
   * setValue, addObject and deleteObject operation to ensure that the next
   * changes are stored in a new revision.
   */
  public incrementRevision(): void {
    this.currentRevision += 1;
  }

  /**
   * Decrement the revision. This should be called to move back to the previous
   * revision if needed.
   */
  public decrementRevision(): void {
    if (this.currentRevision > 0) this.currentRevision -= 1;
  }

  /**
   * Reset the revision to 0. This can be used to start a new iteration
   */
  public resetRevision(): void {
    this.currentRevision = 0;
  }

  /**
   * Check if there is a stored call for the current revision, otherwise store
   * it
   *
   * @param func The function call to check if there is a stored call for the
   *
   * @returns True if there is a stored call for the current revision, false
   * otherwise.
   */
  public calledFunction(func: FunctionCall): boolean {
    const call = this.callStack[this.currentRevision];

    // If there is no stored call for the current revision, store the function
    // and increments the revision
    if (!call) {
      this.callStack[this.currentRevision] = func;
      this.incrementRevision();
      return false;
    };

    // If not a FunctionCall, occurred an error in the previous call, log the
    // error
    if (call.__varType !== 'FunctionCall') {
      console.error(
        'Error: Expected a function call object for revision ' +
        this.currentRevision + ', but got a value: ' + call,
      );
      return false;
    }

    // If the store call is different from the current call, log the error and
    // return false
    if (call.type !== func.type) {
      console.error(
        'Error: Expected a function call of type ' + call.type +
        ' for revision ' + this.currentRevision + ', but got a call of type ' +
        func.type,
      );
      return false;
    }

    // If the store call has differente parameters, log the error and return
    // false
    if (call.called.path !== func.called.path) {
      console.error(
        'Error: Expected a function call with path ' + call.called.path +
        ' for revision ' + this.currentRevision +
        ', but got a call with path ' +
        func.called.path,
      );
      return false;
    }

    // Continue to the next revision
    this.incrementRevision();
    return true;
  }

  /**
   * Check if there is a stored call value for the current revision. This should
   * be called after each getValue, setValue, addObject and deleteObject
   * operation to check if there is a stored call value for the current
   * revision.
   *
   * @param func The function call to check if there is a stored call value for
   *
   * @returns True if there is a stored call value for the current revision,
   * false otherwise.
   */
  public hasCallReturnValue(func: FunctionCall): boolean {
    const value = this.callStack[this.currentRevision];

    // Return false if there is no stored call for the current revision
    if (!value) return false;

    // If the stored call is not a value, log the error and return false
    if (value.__varType !== 'FunctionReturnValue') {
      console.error(
        'Error: Expected a value for revision ' + this.currentRevision +
        ', but got a function call object: ' + JSON.stringify(value),
      );
      return false;
    }

    // If the stored call is a value, check if it is the same type and path as
    // the current function call
    if (value.type !== func.type || value.path !== func.called.path) {
      console.error(
        'Error: Expected a value for revision ' + this.currentRevision +
        ' with type ' + func.type + ' and path ' + func.called.path +
        ', but got a value with type ' + value.type + ' and path ' +
        value.path,
      );
      return false;
    }

    return value !== undefined;
  }
  
  /**
   * Get the stored call value for the current revision. This should be called
   * after each getValue, setValue, addObject and deleteObject operation to
   * ensure that the next changes are stored in a new revision.
   *
   * @returns The stored call value for the current revision, or undefined if
   * there is no stored call for the current revision.
   */
  public getCallReturnValue(
    func: FunctionCall,
  ): boolean | number | string | undefined {
    const stackExec = this.callStack[this.currentRevision];

    // Return false if there is no stored call for the current revision
    if (!stackExec) return false;

    // If the stored call is not a value, log the error and return undefined
    if (stackExec && stackExec.__varType !== 'FunctionReturnValue') {
      console.error(
        'Error: Expected a value for revision ' + this.currentRevision +
        ', but got a function call object: ' + JSON.stringify(stackExec),
      );
      return undefined;
    }

    // If the stored call is a value, check if it is the same type and path as
    // the current function call
    if (stackExec.type !== func.type || stackExec.path !== func.called.path) {
      console.error(
        'Error: Expected a value for revision ' + this.currentRevision +
        ' with type ' + func.type + ' and path ' + func.called.path +
        ', but got a value with type ' + stackExec.type + ' and path ' +
        stackExec.path,
      );
      return undefined;
    }

    this.incrementRevision();
    return stackExec.value;
  }

  /**
   * Store a call value for the current revision. This should be called after
   * each getValue, setValue, addObject and deleteObject operation to ensure
   * that the next changes are stored in a new revision.
   *
   * @param value The value to store for the current revision. It can be a
   * boolean, number or string.
   */
  public storeCallReturnValue(
    func: FunctionCall,
    value: boolean | number | string | undefined,
  ): void {
    this.callStack[this.currentRevision] = {
      __varType: 'FunctionReturnValue',
      type: func.type,
      path: func.called.path,
      value,
    };
    this.incrementRevision();
  }
}
