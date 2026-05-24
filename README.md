# GeoFS-Taxiways-Lights
Addon for turning on taxiway lights in GeoFS in night. This addon can be used for turning on taxiway lights around airports in GeoFS during night. This addon will be useful for all kinds of GeoFS players.


## Features
- Runway Intersection Indicator: Centerline lights switch to yellow when close to a runway to help distinguish intersections.
+ Performance Optimization: Lights that are too close to each other are removed to avoid clutter and improve performance, lights are also removed automatically if they are far away from you

  ## How to install?
  #### 1. Installation
  - Use a userscript extension like Tampermoney or Violentmoney to manage and run userscripts.
  + Once the extension is installed, create a new script, paste in the code from userscript.js, and save it.
  ### 2. Customization
  - You can adjust the taxiway light's parameters like the interval (in seconds), green/yellow light size and the blue light size as well by using the addon settings tab on the bottom of the GeoFS Page.
 
    ## Frequently Asked Questions

   #### How does the script work?
The script takes taxiway data from OpenStreetMap based on your location in game. It then calculates positions for lights along the edges and centerline of nearby taxiways.

#### Why do the lights change color near runways?
Centerline lights turn yellow when near runways to help identify runway intersections more easily.

#### Will this script impact the performace?
The script is optimized to remove lights that are no longer in your vicinity and to avoid placing lights too close together. However, performance may vary depending on your computer's specs.
Note: When you load/reload GeoFS, or when changing locations, it may take up to 3 minutes for all taxiway lights to render.





                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         Made by VT-UTK using some help of Google Antigravity.
