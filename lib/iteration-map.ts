export type CachedValues = {
  [key: string]: boolean | string | number | undefined | CachedValues;
};

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
  private declare valueCache: CachedValues[];

  // private readonly ADD_OBJECT_SUFFIX = '__addObject';
  // private readonly DELETE_OBJECT_SUFFIX = '__deleteObject';

  public constructor() {
    this.currentRevision = 0;
    this.valueCache = [];
  }

  private traversePath(
    path: string,
    revision: CachedValues,
  ): boolean | string | number | undefined  {
    const parts = path.split('.');
    let current: CachedValues = revision;

    // Loop the part of the path
    for (const part of parts) {
      // Continue if the path part is an empty string
      if (part === '') continue;

      // Return early if the part is not found in the current revision
      if (current[part] === undefined) return undefined;

      // If the part is an object, continue traversing, otherwise return the
      // value, otherwise return the found value
      if (typeof current[part] === 'object' && current[part] !== null)
        current = current[part];
      else
        return current[part];
    }

    return undefined;
  }

  /**
   * Try getting the value of the path in the latest revision, if not found, try
   * the previous revision and so on until it finds a value or reaches the first
   * revision.
   *
   * @param path The TR-069 parameter path to get the value for.
   * @returns The value of the parameter in the latest revision, or undefined if
   * not found.
   */
  public getValue(path: string): boolean | string | number | undefined {
    for (let revision = this.currentRevision; revision >= 0; --revision) {
      const value = this.traversePath(path, this.valueCache[revision]);
      if (value !== undefined) return value;
    }

    return undefined;
  }

  /**
   * Save the value of the path in the current revision.
   *
   * @param path The TR-069 parameter path to save the value for.
   * @param value The value to save.
   */
  public saveValue(
    path: string,
    value: boolean | string | number,
  ): void {
    if (!this.valueCache[this.currentRevision])
      this.valueCache[this.currentRevision] = {};

    // Split the path into parts and create nested objects if needed
    const parts = path.split('.').filter((part: string) => part !== '');
    let current: CachedValues = this.valueCache[this.currentRevision];

    // Loop the part of the path except the last one
    for (let partIndex = 0; partIndex < parts.length - 1; ++partIndex) {
      const part = parts[partIndex];

      // Continue if the path part is an empty string
      if (part === '') continue;

      // If the part is not found in the current revision or is not an object,
      // create a new object
      if (current[part] === undefined || typeof current[part] !== 'object')
        current[part] = {};

      // Continue traversing the path
      current = current[part] as CachedValues;
    }

    // Assign the value to the last part of the path
    const lastPart = parts[parts.length - 1];
    current[lastPart] = value;
  }

  /**
   * Increment the revision. This should be called after each setValue,
   * addObject or deleteObject operation to ensure that the next changes are
   * stored in a new revision.
   */
  public incrementRevision(): void {
    this.currentRevision += 1;
  }

  /**
   * Reset the revision to 0. This can be used to start a new iteration
   */
  public resetRevision(): void {
    this.currentRevision = 0;
  }

  /**
   * Get the value of the added object at the given path in the latest revision.
   *
   * @param path The TR-069 parameter path to get the added object value for.
   * @returns The value of the added object in the latest revision, or undefined
   * if not found.
   */
  public getAddObjectValue(
    path: string,
  ): boolean | string | number | undefined {
    this.incrementRevision();
    return this.getValue(path /* + this.ADD_OBJECT_SUFFIX */);
  }

  /**
   * Get the value of the deleted object at the given path in the latest
   * revision.
   *
   * @param path The TR-069 parameter path to get the deleted object value for.
   * @returns The value of the deleted object in the latest revision, or
   * undefined if not found.
   */
  public getDeleteObjectValue(
    path: string,
  ): boolean | string | number | undefined {
    this.incrementRevision();
    return this.getValue(path /* + this.DELETE_OBJECT_SUFFIX */);
  }

  /**
   * Get the value of the setted value at the given path in the latest revision.
   *
   * @param path The TR-069 parameter path to get the setted value for.
   * @returns The value of the setted value in the latest revision, or
   * undefined if not found.
   */
  public getSettedValue(path: string): boolean | string | number | undefined {
    this.incrementRevision();
    return this.getValue(path);
  }

  /**
   * Set the value of the path and increment the revision. This is a convenience
   * method that combines saveValue and incrementRevision, so that you can set a
   * value and automatically move to the next revision.
   *
   * @param path The TR-069 parameter path to set the value for.
   * @param value The value to set.
   */
  public setValue(
    path: string, value: boolean | string | number
  ): void {
    this.incrementRevision();
    this.saveValue(path, value);
  }

  /**
   * Add an object at the given path with the given value. This is just an alias
   * for setValue
   *
   * @param path The TR-069 parameter path to add the object at.
   * @param amount The amount of the object to add.
   */
  public addObject(path: string, amount: boolean | string | number): void {
    this.setValue(path /* + this.ADD_OBJECT_SUFFIX */, amount);
  }

  /**
   * Delete an object at the given path. It also clears all the values that
   * start with the path in the current revision to avoid returning already
   * deleted objects/values.
   *
   * @param path The TR-069 parameter path to delete the object at.
   * @param amount The amount of the object to delete.
   */
  public deleteObject(path: string, amount: boolean | string | number): void {
    this.setValue(path /* + this.DELETE_OBJECT_SUFFIX */, amount);

    // Search all values that start with the path and mark then undefined to the
    // current revision to avoid returning already deleted objects/values
    const pathWithDot = path.endsWith('.') ? path : path + '.';
    // Loop every revision
    for (let revision = this.currentRevision; revision >= 0; --revision) {
      // Loop every path in the revision
      for (const key in this.valueCache[revision]) {
        // If exists, save as undefined to the current revision to mark it as
        // deleted
        if (key === path || key.startsWith(pathWithDot))
          this.valueCache[this.currentRevision][key] = undefined;
      }
    }
  }
}
