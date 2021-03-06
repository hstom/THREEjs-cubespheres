/**
 * @author takahirox / http://github.com/takahirox/
 *
 * Reference: https://en.wikipedia.org/wiki/Cel_shading
 *
 * // How to set default outline parameters
 * new THREE.OutlineEffect( renderer, {
 * 	defaultThickness: 0.01,
 * 	defaultColor: [ 0, 0, 0 ],
 * 	defaultAlpha: 0.8,
 * 	defaultKeepAlive: true // keeps outline material in cache even if material is removed from scene
 * } );
 *
 * // How to set outline parameters for each material
 * material.userData.outlineParameters = {
 * 	thickness: 0.01,
 * 	color: [ 0, 0, 0 ]
 * 	alpha: 0.8,
 * 	visible: true,
 * 	keepAlive: true
 * };
 *
 * TODO
 *  - support shader material without objectNormal in its vertexShader
 */

THREE.OutlineEffect = function ( renderer, parameters ) {

    parameters = parameters || {};

    this.enabled = true;

    var defaultThickness = parameters.defaultThickness !== undefined ? parameters.defaultThickness : 0.003;
    var defaultColor = new THREE.Color().fromArray( parameters.defaultColor !== undefined ? parameters.defaultColor : [ 0, 0, 0 ] );
    var defaultAlpha = parameters.defaultAlpha !== undefined ? parameters.defaultAlpha : 1.0;
    var defaultKeepAlive = parameters.defaultKeepAlive !== undefined ? parameters.defaultKeepAlive : false;

    // object.material.uuid -> outlineMaterial or
    // object.material[ n ].uuid -> outlineMaterial
    // save at the outline material creation and release
    // if it's unused removeThresholdCount frames
    // unless keepAlive is true.
    var cache = {};

    var removeThresholdCount = 60;

    // outlineMaterial.uuid -> object.material or
    // outlineMaterial.uuid -> object.material[ n ]
    // save before render and release after render.
    var originalMaterials = {};

    // object.uuid -> originalOnBeforeRender
    // save before render and release after render.
    var originalOnBeforeRenders = {};

    //this.cache = cache;  // for debug

    // copied from WebGLPrograms and removed some materials
    var shaderIDs = {
        MeshBasicMaterial: 'basic',
        MeshLambertMaterial: 'lambert',
        MeshPhongMaterial: 'phong',
        MeshToonMaterial: 'phong',
        MeshStandardMaterial: 'physical',
        MeshPhysicalMaterial: 'physical'
    };

    var uniformsChunk = {
        outlineThickness: { type: "f", value: defaultThickness },
        outlineColor: { type: "c", value: defaultColor },
        outlineAlpha: { type: "f", value: defaultAlpha }
    };

    var vertexShaderChunk = [

        "#include <fog_pars_vertex>",

        "uniform float outlineThickness;",

        "vec4 calculateOutline( vec4 pos, vec3 objectNormal, vec4 skinned ) {",

        "	float thickness = outlineThickness;",
        "	const float ratio = 1.0;", // TODO: support outline thickness ratio for each vertex
        "	vec4 pos2 = projectionMatrix * modelViewMatrix * vec4( skinned.xyz + objectNormal, 1.0 );",
        // NOTE: subtract pos2 from pos because BackSide objectNormal is negative
        "	vec4 norm = normalize( pos - pos2 );",
        "	return pos + norm * thickness * pos.w * ratio;",

        "}"

    ].join( "\n" );

    var vertexShaderChunk2 = [

        "#if ! defined( LAMBERT ) && ! defined( PHONG ) && ! defined( TOON ) && ! defined( PHYSICAL )",
        "	#ifndef USE_ENVMAP",
        "		vec3 objectNormal = normalize( normal );",
        "	#endif",
        "#endif",

        "#ifdef FLIP_SIDED",
        "	objectNormal = -objectNormal;",
        "#endif",

        "#ifdef DECLARE_TRANSFORMED",
        "	vec3 transformed = vec3( position );",
        "#endif",

        "gl_Position = calculateOutline( gl_Position, objectNormal, vec4( transformed, 1.0 ) );",

        "#include <fog_vertex>"

    ].join( "\n" );

    var fragmentShader = [

        "#include <common>",
        "#include <fog_pars_fragment>",

        "uniform vec3 outlineColor;",
        "uniform float outlineAlpha;",

        "void main() {",

        "	gl_FragColor = vec4( outlineColor, outlineAlpha );",

        "	#include <fog_fragment>",

        "}"

    ].join( "\n" );

    function createInvisibleMaterial() {

        return new THREE.ShaderMaterial( { name: 'invisible', visible: false } );

    }

    function createMaterial( originalMaterial ) {

        var shaderID = shaderIDs[ originalMaterial.type ];
        var originalUniforms, originalVertexShader;
        var outlineParameters = originalMaterial.userData.outlineParameters;

        if ( shaderID !== undefined ) {

            var shader = THREE.ShaderLib[ shaderID ];
            originalUniforms = shader.uniforms;
            originalVertexShader = shader.vertexShader;

        } else if ( originalMaterial.isRawShaderMaterial === true ) {

            originalUniforms = originalMaterial.uniforms;
            originalVertexShader = originalMaterial.vertexShader;

            if ( ! /attribute\s+vec3\s+position\s*;/.test( originalVertexShader ) ||
                ! /attribute\s+vec3\s+normal\s*;/.test( originalVertexShader ) ) {

                console.warn( 'THREE.OutlineEffect requires both vec3 position and normal attributes in vertex shader, ' +
                    'does not draw outline for ' + originalMaterial.name + '(uuid:' + originalMaterial.uuid + ') material.' );

                return createInvisibleMaterial();

            }

        } else if ( originalMaterial.isShaderMaterial === true ) {

            originalUniforms = originalMaterial.uniforms;
            originalVertexShader = originalMaterial.vertexShader;

        } else {

            return createInvisibleMaterial();

        }

        var uniforms = Object.assign( {}, originalUniforms, uniformsChunk );

        var vertexShader = originalVertexShader
        // put vertexShaderChunk right before "void main() {...}"
            .replace( /void\s+main\s*\(\s*\)/, vertexShaderChunk + '\nvoid main()' )
            // put vertexShaderChunk2 the end of "void main() {...}"
            // Note: here assums originalVertexShader ends with "}" of "void main() {...}"
            .replace( /\}\s*$/, vertexShaderChunk2 + '\n}' )
            // remove any light related lines
            // Note: here is very sensitive to originalVertexShader
            // TODO: consider safer way
            .replace( /#include\s+<[\w_]*light[\w_]*>/g, '' );

        var defines = {};

        if ( ! /vec3\s+transformed\s*=/.test( originalVertexShader ) &&
            ! /#include\s+<begin_vertex>/.test( originalVertexShader ) ) defines.DECLARE_TRANSFORMED = true;

        return new THREE.ShaderMaterial( {
            defines: defines,
            uniforms: uniforms,
            vertexShader: vertexShader,
            fragmentShader: fragmentShader,
            side: THREE.BackSide,
            //wireframe: true,
            skinning: false,
            morphTargets: false,
            morphNormals: false,
            fog: false
        } );

    }

    function getOutlineMaterialFromCache( originalMaterial ) {

        var data = cache[ originalMaterial.uuid ];

        if ( data === undefined ) {

            data = {
                material: createMaterial( originalMaterial ),
                used: true,
                keepAlive: defaultKeepAlive,
                count: 0
            };

            cache[ originalMaterial.uuid ] = data;

        }

        data.used = true;

        return data.material;

    }

    function getOutlineMaterial( originalMaterial ) {

        var outlineMaterial = getOutlineMaterialFromCache( originalMaterial );

        originalMaterials[ outlineMaterial.uuid ] = originalMaterial;

        updateOutlineMaterial( outlineMaterial, originalMaterial );

        return outlineMaterial;

    }

    function setOutlineMaterial( object ) {

        if ( object.material === undefined ) return;

        if ( Array.isArray( object.material ) ) {

            for ( var i = 0, il = object.material.length; i < il; i ++ ) {

                object.material[ i ] = getOutlineMaterial( object.material[ i ] );

            }

        } else {

            object.material = getOutlineMaterial( object.material );

        }

        originalOnBeforeRenders[ object.uuid ] = object.onBeforeRender;
        object.onBeforeRender = onBeforeRender;

    }

    function restoreOriginalMaterial( object ) {

        if ( object.material === undefined ) return;

        if ( Array.isArray( object.material ) ) {

            for ( var i = 0, il = object.material.length; i < il; i ++ ) {

                object.material[ i ] = originalMaterials[ object.material[ i ].uuid ];

            }

        } else {

            object.material = originalMaterials[ object.material.uuid ];

        }

        object.onBeforeRender = originalOnBeforeRenders[ object.uuid ];

    }

    function onBeforeRender( renderer, scene, camera, geometry, material, group ) {

        var originalMaterial = originalMaterials[ material.uuid ];

        // just in case
        if ( originalMaterial === undefined ) return;

        updateUniforms( material, originalMaterial );

    }

    function updateUniforms( material, originalMaterial ) {

        var outlineParameters = originalMaterial.userData.outlineParameters;

        material.uniforms.outlineAlpha.value = originalMaterial.opacity;

        if ( outlineParameters !== undefined ) {

            if ( outlineParameters.thickness !== undefined ) material.uniforms.outlineThickness.value = outlineParameters.thickness;
            if ( outlineParameters.color !== undefined ) material.uniforms.outlineColor.value.fromArray( outlineParameters.color );
            if ( outlineParameters.alpha !== undefined ) material.uniforms.outlineAlpha.value = outlineParameters.alpha;

        }

    }

    function updateOutlineMaterial( material, originalMaterial ) {

        if ( material.name === 'invisible' ) return;

        var outlineParameters = originalMaterial.userData.outlineParameters;

        material.skinning = originalMaterial.skinning;
        material.morphTargets = originalMaterial.morphTargets;
        material.morphNormals = originalMaterial.morphNormals;
        material.fog = originalMaterial.fog;

        if ( outlineParameters !== undefined ) {

            if ( originalMaterial.visible === false ) {

                material.visible = false;

            } else {

                material.visible = ( outlineParameters.visible !== undefined ) ? outlineParameters.visible : true;

            }

            material.transparent = ( outlineParameters.alpha !== undefined && outlineParameters.alpha < 1.0 ) ? true : originalMaterial.transparent;

            if ( outlineParameters.keepAlive !== undefined ) cache[ originalMaterial.uuid ].keepAlive = outlineParameters.keepAlive;

        } else {

            material.transparent = originalMaterial.transparent;
            material.visible = originalMaterial.visible;

        }

        if ( originalMaterial.wireframe === true || originalMaterial.depthTest === false ) material.visible = false;

    }

    function cleanupCache() {

        var keys;

        // clear originialMaterials
        keys = Object.keys( originalMaterials );

        for ( var i = 0, il = keys.length; i < il; i ++ ) {

            originalMaterials[ keys[ i ] ] = undefined;

        }

        // clear originalOnBeforeRenders
        keys = Object.keys( originalOnBeforeRenders );

        for ( var i = 0, il = keys.length; i < il; i ++ ) {

            originalOnBeforeRenders[ keys[ i ] ] = undefined;

        }

        // remove unused outlineMaterial from cache
        keys = Object.keys( cache );

        for ( var i = 0, il = keys.length; i < il; i ++ ) {

            var key = keys[ i ];

            if ( cache[ key ].used === false ) {

                cache[ key ].count++;

                if ( cache[ key ].keepAlive === false && cache[ key ].count > removeThresholdCount ) {

                    delete cache[ key ];

                }

            } else {

                cache[ key ].used = false;
                cache[ key ].count = 0;

            }

        }

    }

    this.render = function ( scene, camera ) {

        var renderTarget = null;
        var forceClear = false;

        if ( arguments[ 2 ] !== undefined ) {

            console.warn( 'THREE.OutlineEffect.render(): the renderTarget argument has been removed. Use .setRenderTarget() instead.' );
            renderTarget = arguments[ 2 ];

        }

        if ( arguments[ 3 ] !== undefined ) {

            console.warn( 'THREE.OutlineEffect.render(): the forceClear argument has been removed. Use .clear() instead.' );
            forceClear = arguments[ 3 ];

        }

        renderer.setRenderTarget( renderTarget );

        if ( forceClear ) renderer.clear();

        if ( this.enabled === false ) {

            renderer.render( scene, camera );
            return;

        }

        var currentAutoClear = renderer.autoClear;
        renderer.autoClear = this.autoClear;

        // 1. render normally
        renderer.render( scene, camera );

        // 2. render outline
        var currentSceneAutoUpdate = scene.autoUpdate;
        var currentSceneBackground = scene.background;
        var currentShadowMapEnabled = renderer.shadowMap.enabled;

        scene.autoUpdate = false;
        scene.background = null;
        renderer.autoClear = false;
        renderer.shadowMap.enabled = false;

        scene.traverse( setOutlineMaterial );

        renderer.render( scene, camera );

        scene.traverse( restoreOriginalMaterial );

        cleanupCache();

        scene.autoUpdate = currentSceneAutoUpdate;
        scene.background = currentSceneBackground;
        renderer.autoClear = currentAutoClear;
        renderer.shadowMap.enabled = currentShadowMapEnabled;

    };

    /*
     * See #9918
     *
     * The following property copies and wrapper methods enable
     * THREE.OutlineEffect to be called from other *Effect, like
     *
     * effect = new THREE.StereoEffect( new THREE.OutlineEffect( renderer ) );
     *
     * function render () {
     *
      * 	effect.render( scene, camera );
     *
     * }
     */
    this.autoClear = renderer.autoClear;
    this.domElement = renderer.domElement;
    this.shadowMap = renderer.shadowMap;

    this.clear = function ( color, depth, stencil ) {

        renderer.clear( color, depth, stencil );

    };

    this.getPixelRatio = function () {

        return renderer.getPixelRatio();

    };

    this.setPixelRatio = function ( value ) {

        renderer.setPixelRatio( value );

    };

    this.getSize = function ( target ) {

        return renderer.getSize( target );

    };

    this.setSize = function ( width, height, updateStyle ) {

        renderer.setSize( width, height, updateStyle );

    };

    this.setViewport = function ( x, y, width, height ) {

        renderer.setViewport( x, y, width, height );

    };

    this.setScissor = function ( x, y, width, height ) {

        renderer.setScissor( x, y, width, height );

    };

    this.setScissorTest = function ( boolean ) {

        renderer.setScissorTest( boolean );

    };

    this.setRenderTarget = function ( renderTarget ) {

        renderer.setRenderTarget( renderTarget );

    };

};

var undefined_medium = {"glyphs":{"0":{"ha":833,"x_min":0,"x_max":694,"o":"m 139 972 l 556 972 l 556 833 l 139 833 l 139 972 m 139 278 l 139 139 l 0 139 l 0 833 l 139 833 l 139 417 l 278 417 l 278 278 l 139 278 m 694 833 l 694 139 l 556 139 l 556 556 l 417 556 l 417 694 l 556 694 l 556 833 l 694 833 m 278 556 l 417 556 l 417 417 l 278 417 l 278 556 m 556 0 l 139 0 l 139 139 l 556 139 l 556 0 z "},"1":{"ha":833,"x_min":139,"x_max":556,"o":"m 556 139 l 556 0 l 139 0 l 139 139 l 278 139 l 278 694 l 139 694 l 139 833 l 278 833 l 278 972 l 417 972 l 417 139 l 556 139 z "},"2":{"ha":833,"x_min":0,"x_max":694,"o":"m 556 833 l 139 833 l 139 972 l 556 972 l 556 833 m 0 833 l 139 833 l 139 694 l 0 694 l 0 833 m 694 833 l 694 556 l 556 556 l 556 833 l 694 833 m 417 556 l 556 556 l 556 417 l 417 417 l 417 556 m 278 417 l 417 417 l 417 278 l 278 278 l 278 417 m 139 278 l 278 278 l 278 139 l 694 139 l 694 0 l 0 0 l 0 139 l 139 139 l 139 278 z "},"3":{"ha":833,"x_min":0,"x_max":694,"o":"m 556 833 l 139 833 l 139 972 l 556 972 l 556 833 m 0 833 l 139 833 l 139 694 l 0 694 l 0 833 m 694 833 l 694 556 l 556 556 l 556 833 l 694 833 m 556 556 l 556 417 l 278 417 l 278 556 l 556 556 m 556 417 l 694 417 l 694 139 l 556 139 l 556 417 m 139 278 l 139 139 l 0 139 l 0 278 l 139 278 m 556 0 l 139 0 l 139 139 l 556 139 l 556 0 z "},"4":{"ha":833,"x_min":0,"x_max":694,"o":"m 694 417 l 694 278 l 556 278 l 556 0 l 417 0 l 417 278 l 0 278 l 0 556 l 139 556 l 139 417 l 417 417 l 417 694 l 278 694 l 278 833 l 417 833 l 417 972 l 556 972 l 556 417 l 694 417 m 278 556 l 139 556 l 139 694 l 278 694 l 278 556 z "},"5":{"ha":833,"x_min":0,"x_max":694,"o":"m 139 694 l 556 694 l 556 556 l 0 556 l 0 972 l 694 972 l 694 833 l 139 833 l 139 694 m 694 556 l 694 139 l 556 139 l 556 556 l 694 556 m 139 278 l 139 139 l 0 139 l 0 278 l 139 278 m 556 0 l 139 0 l 139 139 l 556 139 l 556 0 z "},"6":{"ha":833,"x_min":0,"x_max":694,"o":"m 139 972 l 556 972 l 556 833 l 139 833 l 139 972 m 0 139 l 0 833 l 139 833 l 139 694 l 556 694 l 556 556 l 139 556 l 139 139 l 0 139 m 694 556 l 694 139 l 556 139 l 556 556 l 694 556 m 556 0 l 139 0 l 139 139 l 556 139 l 556 0 z "},"7":{"ha":833,"x_min":0,"x_max":694,"o":"m 694 556 l 556 556 l 556 833 l 0 833 l 0 972 l 694 972 l 694 556 m 417 556 l 556 556 l 556 417 l 417 417 l 417 556 m 417 417 l 417 0 l 278 0 l 278 417 l 417 417 z "},"8":{"ha":833,"x_min":0,"x_max":694,"o":"m 139 972 l 556 972 l 556 833 l 139 833 l 139 972 m 139 556 l 0 556 l 0 833 l 139 833 l 139 556 m 694 833 l 694 556 l 556 556 l 556 833 l 694 833 m 556 417 l 139 417 l 139 556 l 556 556 l 556 417 m 139 139 l 0 139 l 0 417 l 139 417 l 139 139 m 556 417 l 694 417 l 694 139 l 556 139 l 556 417 m 556 0 l 139 0 l 139 139 l 556 139 l 556 0 z "},"9":{"ha":833,"x_min":0,"x_max":694,"o":"m 139 972 l 556 972 l 556 833 l 139 833 l 139 972 m 0 417 l 0 833 l 139 833 l 139 417 l 0 417 m 694 833 l 694 139 l 556 139 l 556 278 l 139 278 l 139 417 l 556 417 l 556 833 l 694 833 m 556 0 l 139 0 l 139 139 l 556 139 l 556 0 z "},"\r":{"ha":833,"x_min":0,"x_max":0,"o":""}," ":{"ha":833,"x_min":0,"x_max":0,"o":""},"A":{"ha":833,"x_min":0,"x_max":694,"o":"m 139 972 l 556 972 l 556 833 l 139 833 l 139 972 m 694 833 l 694 0 l 556 0 l 556 417 l 139 417 l 139 0 l 0 0 l 0 833 l 139 833 l 139 556 l 556 556 l 556 833 l 694 833 z "},"Á":{"ha":833,"x_min":0,"x_max":694,"o":"m 139 972 l 556 972 l 556 833 l 139 833 l 139 972 m 694 833 l 694 0 l 556 0 l 556 417 l 139 417 l 139 0 l 0 0 l 0 833 l 139 833 l 139 556 l 556 556 l 556 833 l 694 833 z "},"Ă":{"ha":833,"x_min":0,"x_max":694,"o":"m 139 972 l 556 972 l 556 833 l 139 833 l 139 972 m 694 833 l 694 0 l 556 0 l 556 417 l 139 417 l 139 0 l 0 0 l 0 833 l 139 833 l 139 556 l 556 556 l 556 833 l 694 833 z "},"Â":{"ha":833,"x_min":0,"x_max":694,"o":"m 139 972 l 556 972 l 556 833 l 139 833 l 139 972 m 694 833 l 694 0 l 556 0 l 556 417 l 139 417 l 139 0 l 0 0 l 0 833 l 139 833 l 139 556 l 556 556 l 556 833 l 694 833 z "},"Ä":{"ha":833,"x_min":0,"x_max":694,"o":"m 139 972 l 556 972 l 556 833 l 139 833 l 139 972 m 694 833 l 694 0 l 556 0 l 556 417 l 139 417 l 139 0 l 0 0 l 0 833 l 139 833 l 139 556 l 556 556 l 556 833 l 694 833 z "},"À":{"ha":833,"x_min":0,"x_max":694,"o":"m 139 972 l 556 972 l 556 833 l 139 833 l 139 972 m 694 833 l 694 0 l 556 0 l 556 417 l 139 417 l 139 0 l 0 0 l 0 833 l 139 833 l 139 556 l 556 556 l 556 833 l 694 833 z "},"Ā":{"ha":833,"x_min":0,"x_max":694,"o":"m 139 972 l 556 972 l 556 833 l 139 833 l 139 972 m 694 833 l 694 0 l 556 0 l 556 417 l 139 417 l 139 0 l 0 0 l 0 833 l 139 833 l 139 556 l 556 556 l 556 833 l 694 833 z "},"Ą":{"ha":833,"x_min":0,"x_max":833,"o":"m 139 972 l 556 972 l 556 833 l 139 833 l 139 972 m 556 0 l 556 417 l 139 417 l 139 0 l 0 0 l 0 833 l 139 833 l 139 556 l 556 556 l 556 833 l 694 833 l 694 0 l 556 0 m 556 0 l 556 -139 l 417 -139 l 417 0 l 556 0 m 833 -278 l 556 -278 l 556 -139 l 833 -139 l 833 -278 z "},"Å":{"ha":833,"x_min":0,"x_max":694,"o":"m 139 972 l 556 972 l 556 833 l 139 833 l 139 972 m 694 833 l 694 0 l 556 0 l 556 417 l 139 417 l 139 0 l 0 0 l 0 833 l 139 833 l 139 556 l 556 556 l 556 833 l 694 833 z "},"Ã":{"ha":833,"x_min":0,"x_max":694,"o":"m 139 972 l 556 972 l 556 833 l 139 833 l 139 972 m 694 833 l 694 0 l 556 0 l 556 417 l 139 417 l 139 0 l 0 0 l 0 833 l 139 833 l 139 556 l 556 556 l 556 833 l 694 833 z "},"Æ":{"ha":833,"x_min":0,"x_max":694,"o":"m 417 556 l 556 556 l 556 417 l 417 417 l 417 139 l 694 139 l 694 0 l 278 0 l 278 417 l 139 417 l 139 0 l 0 0 l 0 833 l 139 833 l 139 556 l 278 556 l 278 833 l 139 833 l 139 972 l 694 972 l 694 833 l 417 833 l 417 556 z "},"B":{"ha":833,"x_min":0,"x_max":694,"o":"m 556 417 l 139 417 l 139 139 l 556 139 l 556 0 l 0 0 l 0 972 l 556 972 l 556 833 l 139 833 l 139 556 l 556 556 l 556 417 m 694 833 l 694 556 l 556 556 l 556 833 l 694 833 m 556 417 l 694 417 l 694 139 l 556 139 l 556 417 z "},"C":{"ha":833,"x_min":0,"x_max":694,"o":"m 556 833 l 139 833 l 139 972 l 556 972 l 556 833 m 139 833 l 139 139 l 0 139 l 0 833 l 139 833 m 556 694 l 556 833 l 694 833 l 694 694 l 556 694 m 694 139 l 556 139 l 556 278 l 694 278 l 694 139 m 139 139 l 556 139 l 556 0 l 139 0 l 139 139 z "},"Ć":{"ha":833,"x_min":0,"x_max":694,"o":"m 556 833 l 139 833 l 139 972 l 556 972 l 556 833 m 139 833 l 139 139 l 0 139 l 0 833 l 139 833 m 556 694 l 556 833 l 694 833 l 694 694 l 556 694 m 694 139 l 556 139 l 556 278 l 694 278 l 694 139 m 139 139 l 556 139 l 556 0 l 139 0 l 139 139 z "},"Č":{"ha":833,"x_min":0,"x_max":694,"o":"m 556 833 l 139 833 l 139 972 l 556 972 l 556 833 m 139 833 l 139 139 l 0 139 l 0 833 l 139 833 m 556 694 l 556 833 l 694 833 l 694 694 l 556 694 m 694 139 l 556 139 l 556 278 l 694 278 l 694 139 m 139 139 l 556 139 l 556 0 l 139 0 l 139 139 z "},"Ç":{"ha":833,"x_min":0,"x_max":694,"o":"m 556 833 l 139 833 l 139 972 l 556 972 l 556 833 m 139 833 l 139 139 l 0 139 l 0 833 l 139 833 m 556 694 l 556 833 l 694 833 l 694 694 l 556 694 m 694 139 l 556 139 l 556 278 l 694 278 l 694 139 m 139 139 l 556 139 l 556 -139 l 417 -139 l 417 0 l 139 0 l 139 139 m 417 -139 l 417 -278 l 139 -278 l 139 -139 l 417 -139 z "},"Ċ":{"ha":833,"x_min":0,"x_max":694,"o":"m 556 833 l 139 833 l 139 972 l 556 972 l 556 833 m 139 833 l 139 139 l 0 139 l 0 833 l 139 833 m 556 694 l 556 833 l 694 833 l 694 694 l 556 694 m 694 139 l 556 139 l 556 278 l 694 278 l 694 139 m 139 139 l 556 139 l 556 0 l 139 0 l 139 139 z "},"D":{"ha":833,"x_min":0,"x_max":694,"o":"m 556 0 l 0 0 l 0 972 l 556 972 l 556 833 l 139 833 l 139 139 l 556 139 l 556 0 m 694 833 l 694 139 l 556 139 l 556 833 l 694 833 z "},"Ð":{"ha":833,"x_min":-139,"x_max":694,"o":"m 556 0 l 0 0 l 0 417 l -139 417 l -139 556 l 0 556 l 0 972 l 556 972 l 556 833 l 139 833 l 139 556 l 278 556 l 278 417 l 139 417 l 139 139 l 556 139 l 556 0 m 694 833 l 694 139 l 556 139 l 556 833 l 694 833 z "},"Ď":{"ha":833,"x_min":0,"x_max":694,"o":"m 556 0 l 0 0 l 0 972 l 556 972 l 556 833 l 139 833 l 139 139 l 556 139 l 556 0 m 694 833 l 694 139 l 556 139 l 556 833 l 694 833 z "},"Đ":{"ha":833,"x_min":-139,"x_max":694,"o":"m 556 0 l 0 0 l 0 417 l -139 417 l -139 556 l 0 556 l 0 972 l 556 972 l 556 833 l 139 833 l 139 556 l 278 556 l 278 417 l 139 417 l 139 139 l 556 139 l 556 0 m 694 833 l 694 139 l 556 139 l 556 833 l 694 833 z "},"E":{"ha":833,"x_min":0,"x_max":694,"o":"m 139 556 l 556 556 l 556 417 l 139 417 l 139 139 l 694 139 l 694 0 l 0 0 l 0 972 l 694 972 l 694 833 l 139 833 l 139 556 z "},"É":{"ha":833,"x_min":0,"x_max":694,"o":"m 139 556 l 556 556 l 556 417 l 139 417 l 139 139 l 694 139 l 694 0 l 0 0 l 0 972 l 694 972 l 694 833 l 139 833 l 139 556 z "},"Ě":{"ha":833,"x_min":0,"x_max":694,"o":"m 139 556 l 556 556 l 556 417 l 139 417 l 139 139 l 694 139 l 694 0 l 0 0 l 0 972 l 694 972 l 694 833 l 139 833 l 139 556 z "},"Ê":{"ha":833,"x_min":0,"x_max":694,"o":"m 139 556 l 556 556 l 556 417 l 139 417 l 139 139 l 694 139 l 694 0 l 0 0 l 0 972 l 694 972 l 694 833 l 139 833 l 139 556 z "},"Ë":{"ha":833,"x_min":0,"x_max":694,"o":"m 139 556 l 556 556 l 556 417 l 139 417 l 139 139 l 694 139 l 694 0 l 0 0 l 0 972 l 694 972 l 694 833 l 139 833 l 139 556 z "},"Ė":{"ha":833,"x_min":0,"x_max":694,"o":"m 139 556 l 556 556 l 556 417 l 139 417 l 139 139 l 694 139 l 694 0 l 0 0 l 0 972 l 694 972 l 694 833 l 139 833 l 139 556 z "},"È":{"ha":833,"x_min":0,"x_max":694,"o":"m 139 556 l 556 556 l 556 417 l 139 417 l 139 139 l 694 139 l 694 0 l 0 0 l 0 972 l 694 972 l 694 833 l 139 833 l 139 556 z "},"Ē":{"ha":833,"x_min":0,"x_max":694,"o":"m 139 556 l 556 556 l 556 417 l 139 417 l 139 139 l 694 139 l 694 0 l 0 0 l 0 972 l 694 972 l 694 833 l 139 833 l 139 556 z "},"Ę":{"ha":833,"x_min":0,"x_max":833,"o":"m 556 0 l 556 -139 l 417 -139 l 417 0 l 0 0 l 0 972 l 694 972 l 694 833 l 139 833 l 139 556 l 556 556 l 556 417 l 139 417 l 139 139 l 694 139 l 694 0 l 556 0 m 833 -278 l 556 -278 l 556 -139 l 833 -139 l 833 -278 z "},"F":{"ha":833,"x_min":0,"x_max":694,"o":"m 694 833 l 139 833 l 139 556 l 556 556 l 556 417 l 139 417 l 139 0 l 0 0 l 0 972 l 694 972 l 694 833 z "},"G":{"ha":833,"x_min":0,"x_max":694,"o":"m 556 833 l 139 833 l 139 972 l 556 972 l 556 833 m 139 833 l 139 139 l 0 139 l 0 833 l 139 833 m 556 694 l 556 833 l 694 833 l 694 694 l 556 694 m 556 139 l 556 417 l 417 417 l 417 556 l 694 556 l 694 139 l 556 139 m 139 139 l 556 139 l 556 0 l 139 0 l 139 139 z "},"Ğ":{"ha":833,"x_min":0,"x_max":694,"o":"m 556 833 l 139 833 l 139 972 l 556 972 l 556 833 m 139 833 l 139 139 l 0 139 l 0 833 l 139 833 m 556 694 l 556 833 l 694 833 l 694 694 l 556 694 m 556 139 l 556 417 l 417 417 l 417 556 l 694 556 l 694 139 l 556 139 m 139 139 l 556 139 l 556 0 l 139 0 l 139 139 z "},"Ģ":{"ha":833,"x_min":0,"x_max":694,"o":"m 556 833 l 139 833 l 139 972 l 556 972 l 556 833 m 139 833 l 139 139 l 0 139 l 0 833 l 139 833 m 556 694 l 556 833 l 694 833 l 694 694 l 556 694 m 556 139 l 556 417 l 417 417 l 417 556 l 694 556 l 694 139 l 556 139 m 139 139 l 556 139 l 556 0 l 139 0 l 139 139 z "},"Ġ":{"ha":833,"x_min":0,"x_max":694,"o":"m 556 833 l 139 833 l 139 972 l 556 972 l 556 833 m 139 833 l 139 139 l 0 139 l 0 833 l 139 833 m 556 694 l 556 833 l 694 833 l 694 694 l 556 694 m 556 139 l 556 417 l 417 417 l 417 556 l 694 556 l 694 139 l 556 139 m 139 139 l 556 139 l 556 0 l 139 0 l 139 139 z "},"H":{"ha":833,"x_min":0,"x_max":694,"o":"m 694 972 l 694 0 l 556 0 l 556 417 l 139 417 l 139 0 l 0 0 l 0 972 l 139 972 l 139 556 l 556 556 l 556 972 l 694 972 z "},"Ħ":{"ha":833,"x_min":-139,"x_max":833,"o":"m 833 833 l 833 694 l 694 694 l 694 0 l 556 0 l 556 417 l 139 417 l 139 0 l 0 0 l 0 694 l -139 694 l -139 833 l 0 833 l 0 972 l 139 972 l 139 833 l 556 833 l 556 972 l 694 972 l 694 833 l 833 833 m 556 694 l 139 694 l 139 556 l 556 556 l 556 694 z "},"I":{"ha":833,"x_min":139,"x_max":556,"o":"m 556 139 l 556 0 l 139 0 l 139 139 l 278 139 l 278 833 l 139 833 l 139 972 l 556 972 l 556 833 l 417 833 l 417 139 l 556 139 z "},"Ĳ":{"ha":833,"x_min":0,"x_max":694,"o":"m 0 0 l 0 139 l 139 139 l 139 833 l 0 833 l 0 972 l 417 972 l 417 833 l 278 833 l 278 139 l 417 139 l 417 0 l 0 0 m 694 972 l 694 -139 l 556 -139 l 556 972 l 694 972 m 556 -139 l 556 -278 l 278 -278 l 278 -139 l 556 -139 z "},"Í":{"ha":833,"x_min":139,"x_max":556,"o":"m 556 139 l 556 0 l 139 0 l 139 139 l 278 139 l 278 833 l 139 833 l 139 972 l 556 972 l 556 833 l 417 833 l 417 139 l 556 139 z "},"Î":{"ha":833,"x_min":139,"x_max":556,"o":"m 556 139 l 556 0 l 139 0 l 139 139 l 278 139 l 278 833 l 139 833 l 139 972 l 556 972 l 556 833 l 417 833 l 417 139 l 556 139 z "},"Ï":{"ha":833,"x_min":139,"x_max":556,"o":"m 556 139 l 556 0 l 139 0 l 139 139 l 278 139 l 278 833 l 139 833 l 139 972 l 556 972 l 556 833 l 417 833 l 417 139 l 556 139 z "},"İ":{"ha":833,"x_min":139,"x_max":556,"o":"m 556 139 l 556 0 l 139 0 l 139 139 l 278 139 l 278 833 l 139 833 l 139 972 l 556 972 l 556 833 l 417 833 l 417 139 l 556 139 z "},"Ì":{"ha":833,"x_min":139,"x_max":556,"o":"m 556 139 l 556 0 l 139 0 l 139 139 l 278 139 l 278 833 l 139 833 l 139 972 l 556 972 l 556 833 l 417 833 l 417 139 l 556 139 z "},"Ī":{"ha":833,"x_min":139,"x_max":556,"o":"m 556 139 l 556 0 l 139 0 l 139 139 l 278 139 l 278 833 l 139 833 l 139 972 l 556 972 l 556 833 l 417 833 l 417 139 l 556 139 z "},"Į":{"ha":833,"x_min":139,"x_max":694,"o":"m 417 0 l 417 -139 l 278 -139 l 278 0 l 139 0 l 139 139 l 278 139 l 278 833 l 139 833 l 139 972 l 556 972 l 556 833 l 417 833 l 417 139 l 556 139 l 556 0 l 417 0 m 694 -278 l 417 -278 l 417 -139 l 694 -139 l 694 -278 z "},"J":{"ha":833,"x_min":0,"x_max":694,"o":"m 694 972 l 694 139 l 556 139 l 556 972 l 694 972 m 139 139 l 0 139 l 0 417 l 139 417 l 139 139 m 556 0 l 139 0 l 139 139 l 556 139 l 556 0 z "},"K":{"ha":833,"x_min":0,"x_max":694,"o":"m 278 556 l 278 417 l 139 417 l 139 0 l 0 0 l 0 972 l 139 972 l 139 556 l 278 556 m 694 833 l 556 833 l 556 972 l 694 972 l 694 833 m 556 694 l 417 694 l 417 833 l 556 833 l 556 694 m 417 556 l 278 556 l 278 694 l 417 694 l 417 556 m 278 278 l 278 417 l 417 417 l 417 278 l 278 278 m 417 139 l 417 278 l 556 278 l 556 139 l 417 139 m 556 0 l 556 139 l 694 139 l 694 0 l 556 0 z "},"Ķ":{"ha":833,"x_min":0,"x_max":694,"o":"m 278 556 l 278 417 l 139 417 l 139 0 l 0 0 l 0 972 l 139 972 l 139 556 l 278 556 m 694 833 l 556 833 l 556 972 l 694 972 l 694 833 m 556 694 l 417 694 l 417 833 l 556 833 l 556 694 m 417 556 l 278 556 l 278 694 l 417 694 l 417 556 m 278 278 l 278 417 l 417 417 l 417 278 l 278 278 m 417 139 l 417 278 l 556 278 l 556 139 l 417 139 m 556 0 l 556 139 l 694 139 l 694 0 l 556 0 z "},"L":{"ha":833,"x_min":0,"x_max":694,"o":"m 694 0 l 0 0 l 0 972 l 139 972 l 139 139 l 694 139 l 694 0 z "},"Ĺ":{"ha":833,"x_min":0,"x_max":694,"o":"m 694 0 l 0 0 l 0 972 l 139 972 l 139 139 l 694 139 l 694 0 z "},"Ľ":{"ha":833,"x_min":0,"x_max":694,"o":"m 417 833 l 417 1111 l 556 1111 l 556 833 l 417 833 m 694 0 l 0 0 l 0 972 l 139 972 l 139 139 l 694 139 l 694 0 m 417 694 l 278 694 l 278 833 l 417 833 l 417 694 z "},"Ļ":{"ha":833,"x_min":0,"x_max":694,"o":"m 694 0 l 0 0 l 0 972 l 139 972 l 139 139 l 694 139 l 694 0 z "},"Ł":{"ha":833,"x_min":-139,"x_max":694,"o":"m 694 0 l 0 0 l 0 278 l -139 278 l -139 417 l 0 417 l 0 972 l 139 972 l 139 556 l 278 556 l 278 417 l 139 417 l 139 139 l 694 139 l 694 0 z "},"M":{"ha":833,"x_min":0,"x_max":694,"o":"m 278 833 l 278 694 l 139 694 l 139 0 l 0 0 l 0 972 l 139 972 l 139 833 l 278 833 m 694 972 l 694 0 l 556 0 l 556 694 l 417 694 l 417 833 l 556 833 l 556 972 l 694 972 m 278 694 l 417 694 l 417 556 l 278 556 l 278 694 z "},"N":{"ha":833,"x_min":0,"x_max":694,"o":"m 278 694 l 278 556 l 139 556 l 139 0 l 0 0 l 0 972 l 139 972 l 139 694 l 278 694 m 694 972 l 694 0 l 556 0 l 556 278 l 417 278 l 417 417 l 556 417 l 556 972 l 694 972 m 417 556 l 417 417 l 278 417 l 278 556 l 417 556 z "},"Ń":{"ha":833,"x_min":0,"x_max":694,"o":"m 278 694 l 278 556 l 139 556 l 139 0 l 0 0 l 0 972 l 139 972 l 139 694 l 278 694 m 694 972 l 694 0 l 556 0 l 556 278 l 417 278 l 417 417 l 556 417 l 556 972 l 694 972 m 417 556 l 417 417 l 278 417 l 278 556 l 417 556 z "},"Ň":{"ha":833,"x_min":0,"x_max":694,"o":"m 278 694 l 278 556 l 139 556 l 139 0 l 0 0 l 0 972 l 139 972 l 139 694 l 278 694 m 694 972 l 694 0 l 556 0 l 556 278 l 417 278 l 417 417 l 556 417 l 556 972 l 694 972 m 417 556 l 417 417 l 278 417 l 278 556 l 417 556 z "},"Ņ":{"ha":833,"x_min":0,"x_max":694,"o":"m 278 694 l 278 556 l 139 556 l 139 0 l 0 0 l 0 972 l 139 972 l 139 694 l 278 694 m 694 972 l 694 0 l 556 0 l 556 278 l 417 278 l 417 417 l 556 417 l 556 972 l 694 972 m 417 556 l 417 417 l 278 417 l 278 556 l 417 556 z "},"Ŋ":{"ha":833,"x_min":0,"x_max":694,"o":"m 278 694 l 278 556 l 139 556 l 139 0 l 0 0 l 0 972 l 139 972 l 139 694 l 278 694 m 694 972 l 694 -139 l 556 -139 l 556 278 l 417 278 l 417 417 l 556 417 l 556 972 l 694 972 m 417 556 l 417 417 l 278 417 l 278 556 l 417 556 m 556 -139 l 556 -278 l 278 -278 l 278 -139 l 556 -139 z "},"Ñ":{"ha":833,"x_min":0,"x_max":694,"o":"m 278 694 l 278 556 l 139 556 l 139 0 l 0 0 l 0 972 l 139 972 l 139 694 l 278 694 m 694 972 l 694 0 l 556 0 l 556 278 l 417 278 l 417 417 l 556 417 l 556 972 l 694 972 m 417 556 l 417 417 l 278 417 l 278 556 l 417 556 z "},"O":{"ha":833,"x_min":0,"x_max":694,"o":"m 139 972 l 556 972 l 556 833 l 139 833 l 139 972 m 0 139 l 0 833 l 139 833 l 139 139 l 0 139 m 694 833 l 694 139 l 556 139 l 556 833 l 694 833 m 556 0 l 139 0 l 139 139 l 556 139 l 556 0 z "},"Ó":{"ha":833,"x_min":0,"x_max":694,"o":"m 139 972 l 556 972 l 556 833 l 139 833 l 139 972 m 0 139 l 0 833 l 139 833 l 139 139 l 0 139 m 694 833 l 694 139 l 556 139 l 556 833 l 694 833 m 556 0 l 139 0 l 139 139 l 556 139 l 556 0 z "},"Ô":{"ha":833,"x_min":0,"x_max":694,"o":"m 139 972 l 556 972 l 556 833 l 139 833 l 139 972 m 0 139 l 0 833 l 139 833 l 139 139 l 0 139 m 694 833 l 694 139 l 556 139 l 556 833 l 694 833 m 556 0 l 139 0 l 139 139 l 556 139 l 556 0 z "},"Ö":{"ha":833,"x_min":0,"x_max":694,"o":"m 139 972 l 556 972 l 556 833 l 139 833 l 139 972 m 0 139 l 0 833 l 139 833 l 139 139 l 0 139 m 694 833 l 694 139 l 556 139 l 556 833 l 694 833 m 556 0 l 139 0 l 139 139 l 556 139 l 556 0 z "},"Ò":{"ha":833,"x_min":0,"x_max":694,"o":"m 139 972 l 556 972 l 556 833 l 139 833 l 139 972 m 0 139 l 0 833 l 139 833 l 139 139 l 0 139 m 694 833 l 694 139 l 556 139 l 556 833 l 694 833 m 556 0 l 139 0 l 139 139 l 556 139 l 556 0 z "},"Ő":{"ha":833,"x_min":0,"x_max":694,"o":"m 139 972 l 556 972 l 556 833 l 139 833 l 139 972 m 0 139 l 0 833 l 139 833 l 139 139 l 0 139 m 694 833 l 694 139 l 556 139 l 556 833 l 694 833 m 556 0 l 139 0 l 139 139 l 556 139 l 556 0 z "},"Ō":{"ha":833,"x_min":0,"x_max":694,"o":"m 139 972 l 556 972 l 556 833 l 139 833 l 139 972 m 0 139 l 0 833 l 139 833 l 139 139 l 0 139 m 694 833 l 694 139 l 556 139 l 556 833 l 694 833 m 556 0 l 139 0 l 139 139 l 556 139 l 556 0 z "},"Ø":{"ha":833,"x_min":-139,"x_max":833,"o":"m 139 972 l 556 972 l 556 833 l 139 833 l 139 972 m 833 972 l 833 833 l 694 833 l 694 972 l 833 972 m 139 278 l 139 139 l 0 139 l 0 833 l 139 833 l 139 417 l 278 417 l 278 278 l 139 278 m 556 833 l 694 833 l 694 139 l 556 139 l 556 556 l 417 556 l 417 694 l 556 694 l 556 833 m 278 556 l 417 556 l 417 417 l 278 417 l 278 556 m -139 139 l 0 139 l 0 0 l -139 0 l -139 139 m 556 0 l 139 0 l 139 139 l 556 139 l 556 0 z "},"Õ":{"ha":833,"x_min":0,"x_max":694,"o":"m 139 972 l 556 972 l 556 833 l 139 833 l 139 972 m 0 139 l 0 833 l 139 833 l 139 139 l 0 139 m 694 833 l 694 139 l 556 139 l 556 833 l 694 833 m 556 0 l 139 0 l 139 139 l 556 139 l 556 0 z "},"Œ":{"ha":833,"x_min":0,"x_max":694,"o":"m 417 556 l 556 556 l 556 417 l 417 417 l 417 139 l 694 139 l 694 0 l 139 0 l 139 139 l 278 139 l 278 833 l 139 833 l 139 972 l 694 972 l 694 833 l 417 833 l 417 556 m 0 139 l 0 833 l 139 833 l 139 139 l 0 139 z "},"P":{"ha":833,"x_min":0,"x_max":694,"o":"m 556 417 l 139 417 l 139 0 l 0 0 l 0 972 l 556 972 l 556 833 l 139 833 l 139 556 l 556 556 l 556 417 m 694 833 l 694 556 l 556 556 l 556 833 l 694 833 z "},"Þ":{"ha":833,"x_min":0,"x_max":694,"o":"m 556 139 l 139 139 l 139 0 l 0 0 l 0 972 l 139 972 l 139 833 l 556 833 l 556 694 l 139 694 l 139 278 l 556 278 l 556 139 m 694 694 l 694 278 l 556 278 l 556 694 l 694 694 z "},"Q":{"ha":833,"x_min":0,"x_max":694,"o":"m 139 972 l 556 972 l 556 833 l 139 833 l 139 972 m 0 139 l 0 833 l 139 833 l 139 139 l 0 139 m 694 833 l 694 139 l 556 139 l 556 833 l 694 833 m 556 0 l 694 0 l 694 -139 l 417 -139 l 417 0 l 139 0 l 139 139 l 556 139 l 556 0 z "},"R":{"ha":833,"x_min":0,"x_max":694,"o":"m 556 417 l 139 417 l 139 0 l 0 0 l 0 972 l 556 972 l 556 833 l 139 833 l 139 556 l 556 556 l 556 417 m 694 833 l 694 556 l 556 556 l 556 833 l 694 833 m 694 417 l 694 0 l 556 0 l 556 417 l 694 417 z "},"Ŕ":{"ha":833,"x_min":0,"x_max":694,"o":"m 556 417 l 139 417 l 139 0 l 0 0 l 0 972 l 556 972 l 556 833 l 139 833 l 139 556 l 556 556 l 556 417 m 694 833 l 694 556 l 556 556 l 556 833 l 694 833 m 694 417 l 694 0 l 556 0 l 556 417 l 694 417 z "},"Ř":{"ha":833,"x_min":0,"x_max":694,"o":"m 556 417 l 139 417 l 139 0 l 0 0 l 0 972 l 556 972 l 556 833 l 139 833 l 139 556 l 556 556 l 556 417 m 694 833 l 694 556 l 556 556 l 556 833 l 694 833 m 694 417 l 694 0 l 556 0 l 556 417 l 694 417 z "},"Ŗ":{"ha":833,"x_min":0,"x_max":694,"o":"m 556 417 l 139 417 l 139 0 l 0 0 l 0 972 l 556 972 l 556 833 l 139 833 l 139 556 l 556 556 l 556 417 m 694 833 l 694 556 l 556 556 l 556 833 l 694 833 m 694 417 l 694 0 l 556 0 l 556 417 l 694 417 z "},"S":{"ha":833,"x_min":0,"x_max":694,"o":"m 556 833 l 139 833 l 139 972 l 556 972 l 556 833 m 139 833 l 139 556 l 0 556 l 0 833 l 139 833 m 556 694 l 556 833 l 694 833 l 694 694 l 556 694 m 139 556 l 556 556 l 556 417 l 139 417 l 139 556 m 556 417 l 694 417 l 694 139 l 556 139 l 556 417 m 139 278 l 139 139 l 0 139 l 0 278 l 139 278 m 556 0 l 139 0 l 139 139 l 556 139 l 556 0 z "},"Ś":{"ha":833,"x_min":0,"x_max":694,"o":"m 556 833 l 139 833 l 139 972 l 556 972 l 556 833 m 139 833 l 139 556 l 0 556 l 0 833 l 139 833 m 556 694 l 556 833 l 694 833 l 694 694 l 556 694 m 139 556 l 556 556 l 556 417 l 139 417 l 139 556 m 556 417 l 694 417 l 694 139 l 556 139 l 556 417 m 139 278 l 139 139 l 0 139 l 0 278 l 139 278 m 556 0 l 139 0 l 139 139 l 556 139 l 556 0 z "},"Š":{"ha":833,"x_min":0,"x_max":694,"o":"m 556 833 l 139 833 l 139 972 l 556 972 l 556 833 m 139 833 l 139 556 l 0 556 l 0 833 l 139 833 m 556 694 l 556 833 l 694 833 l 694 694 l 556 694 m 139 556 l 556 556 l 556 417 l 139 417 l 139 556 m 556 417 l 694 417 l 694 139 l 556 139 l 556 417 m 139 278 l 139 139 l 0 139 l 0 278 l 139 278 m 556 0 l 139 0 l 139 139 l 556 139 l 556 0 z "},"Ş":{"ha":833,"x_min":0,"x_max":694,"o":"m 556 833 l 139 833 l 139 972 l 556 972 l 556 833 m 139 833 l 139 556 l 0 556 l 0 833 l 139 833 m 556 694 l 556 833 l 694 833 l 694 694 l 556 694 m 139 556 l 556 556 l 556 417 l 139 417 l 139 556 m 556 417 l 694 417 l 694 139 l 556 139 l 556 417 m 139 278 l 139 139 l 0 139 l 0 278 l 139 278 m 556 -139 l 417 -139 l 417 0 l 139 0 l 139 139 l 556 139 l 556 -139 m 417 -139 l 417 -278 l 139 -278 l 139 -139 l 417 -139 z "},"Ș":{"ha":833,"x_min":0,"x_max":694,"o":"m 556 833 l 139 833 l 139 972 l 556 972 l 556 833 m 139 833 l 139 556 l 0 556 l 0 833 l 139 833 m 556 694 l 556 833 l 694 833 l 694 694 l 556 694 m 139 556 l 556 556 l 556 417 l 139 417 l 139 556 m 556 417 l 694 417 l 694 139 l 556 139 l 556 417 m 139 278 l 139 139 l 0 139 l 0 278 l 139 278 m 556 0 l 139 0 l 139 139 l 556 139 l 556 0 z "},"ẞ":{"ha":833,"x_min":0,"x_max":694,"o":"m 556 833 l 139 833 l 139 972 l 556 972 l 556 833 m 139 833 l 139 0 l 0 0 l 0 833 l 139 833 m 694 694 l 556 694 l 556 833 l 694 833 l 694 694 m 556 417 l 417 417 l 417 694 l 556 694 l 556 417 m 556 417 l 694 417 l 694 139 l 556 139 l 556 417 m 556 139 l 556 0 l 278 0 l 278 139 l 556 139 z "},"T":{"ha":833,"x_min":0,"x_max":694,"o":"m 694 833 l 417 833 l 417 0 l 278 0 l 278 833 l 0 833 l 0 972 l 694 972 l 694 833 z "},"Ŧ":{"ha":833,"x_min":0,"x_max":694,"o":"m 694 833 l 417 833 l 417 556 l 556 556 l 556 417 l 417 417 l 417 0 l 278 0 l 278 417 l 139 417 l 139 556 l 278 556 l 278 833 l 0 833 l 0 972 l 694 972 l 694 833 z "},"Ť":{"ha":833,"x_min":0,"x_max":694,"o":"m 694 833 l 417 833 l 417 0 l 278 0 l 278 833 l 0 833 l 0 972 l 694 972 l 694 833 z "},"Ţ":{"ha":833,"x_min":0,"x_max":694,"o":"m 694 833 l 417 833 l 417 0 l 278 0 l 278 833 l 0 833 l 0 972 l 694 972 l 694 833 m 417 -139 l 417 0 l 556 0 l 556 -139 l 417 -139 m 417 -139 l 417 -278 l 139 -278 l 139 -139 l 417 -139 z "},"Ț":{"ha":833,"x_min":0,"x_max":694,"o":"m 694 833 l 417 833 l 417 0 l 278 0 l 278 833 l 0 833 l 0 972 l 694 972 l 694 833 z "},"U":{"ha":833,"x_min":0,"x_max":694,"o":"m 0 139 l 0 972 l 139 972 l 139 139 l 0 139 m 694 972 l 694 0 l 139 0 l 139 139 l 556 139 l 556 972 l 694 972 z "},"Ú":{"ha":833,"x_min":0,"x_max":694,"o":"m 0 139 l 0 972 l 139 972 l 139 139 l 0 139 m 694 972 l 694 0 l 139 0 l 139 139 l 556 139 l 556 972 l 694 972 z "},"Û":{"ha":833,"x_min":0,"x_max":694,"o":"m 0 139 l 0 972 l 139 972 l 139 139 l 0 139 m 694 972 l 694 0 l 139 0 l 139 139 l 556 139 l 556 972 l 694 972 z "},"Ü":{"ha":833,"x_min":0,"x_max":694,"o":"m 0 139 l 0 972 l 139 972 l 139 139 l 0 139 m 694 972 l 694 0 l 139 0 l 139 139 l 556 139 l 556 972 l 694 972 z "},"Ù":{"ha":833,"x_min":0,"x_max":694,"o":"m 0 139 l 0 972 l 139 972 l 139 139 l 0 139 m 694 972 l 694 0 l 139 0 l 139 139 l 556 139 l 556 972 l 694 972 z "},"Ű":{"ha":833,"x_min":0,"x_max":694,"o":"m 0 139 l 0 972 l 139 972 l 139 139 l 0 139 m 694 972 l 694 0 l 139 0 l 139 139 l 556 139 l 556 972 l 694 972 z "},"Ū":{"ha":833,"x_min":0,"x_max":694,"o":"m 0 139 l 0 972 l 139 972 l 139 139 l 0 139 m 694 972 l 694 0 l 139 0 l 139 139 l 556 139 l 556 972 l 694 972 z "},"Ų":{"ha":833,"x_min":0,"x_max":833,"o":"m 0 139 l 0 972 l 139 972 l 139 139 l 0 139 m 556 0 l 556 -139 l 417 -139 l 417 0 l 139 0 l 139 139 l 556 139 l 556 972 l 694 972 l 694 0 l 556 0 m 833 -278 l 556 -278 l 556 -139 l 833 -139 l 833 -278 z "},"Ů":{"ha":833,"x_min":0,"x_max":694,"o":"m 0 139 l 0 972 l 139 972 l 139 139 l 0 139 m 694 972 l 694 0 l 139 0 l 139 139 l 556 139 l 556 972 l 694 972 z "},"V":{"ha":833,"x_min":0,"x_max":694,"o":"m 0 556 l 0 972 l 139 972 l 139 556 l 0 556 m 694 972 l 694 556 l 556 556 l 556 972 l 694 972 m 278 278 l 139 278 l 139 556 l 278 556 l 278 278 m 556 556 l 556 278 l 417 278 l 417 556 l 556 556 m 417 278 l 417 0 l 278 0 l 278 278 l 417 278 z "},"W":{"ha":833,"x_min":0,"x_max":694,"o":"m 278 278 l 278 139 l 139 139 l 139 0 l 0 0 l 0 972 l 139 972 l 139 278 l 278 278 m 694 972 l 694 0 l 556 0 l 556 139 l 417 139 l 417 278 l 556 278 l 556 972 l 694 972 m 417 417 l 417 278 l 278 278 l 278 417 l 417 417 z "},"Ẃ":{"ha":833,"x_min":0,"x_max":694,"o":"m 278 278 l 278 139 l 139 139 l 139 0 l 0 0 l 0 972 l 139 972 l 139 278 l 278 278 m 694 972 l 694 0 l 556 0 l 556 139 l 417 139 l 417 278 l 556 278 l 556 972 l 694 972 m 417 417 l 417 278 l 278 278 l 278 417 l 417 417 z "},"Ŵ":{"ha":833,"x_min":0,"x_max":694,"o":"m 278 278 l 278 139 l 139 139 l 139 0 l 0 0 l 0 972 l 139 972 l 139 278 l 278 278 m 694 972 l 694 0 l 556 0 l 556 139 l 417 139 l 417 278 l 556 278 l 556 972 l 694 972 m 417 417 l 417 278 l 278 278 l 278 417 l 417 417 z "},"Ẅ":{"ha":833,"x_min":0,"x_max":694,"o":"m 278 278 l 278 139 l 139 139 l 139 0 l 0 0 l 0 972 l 139 972 l 139 278 l 278 278 m 694 972 l 694 0 l 556 0 l 556 139 l 417 139 l 417 278 l 556 278 l 556 972 l 694 972 m 417 417 l 417 278 l 278 278 l 278 417 l 417 417 z "},"Ẁ":{"ha":833,"x_min":0,"x_max":694,"o":"m 278 278 l 278 139 l 139 139 l 139 0 l 0 0 l 0 972 l 139 972 l 139 278 l 278 278 m 694 972 l 694 0 l 556 0 l 556 139 l 417 139 l 417 278 l 556 278 l 556 972 l 694 972 m 417 417 l 417 278 l 278 278 l 278 417 l 417 417 z "},"X":{"ha":833,"x_min":0,"x_max":694,"o":"m 139 694 l 0 694 l 0 972 l 139 972 l 139 694 m 694 972 l 694 694 l 556 694 l 556 972 l 694 972 m 278 694 l 278 556 l 139 556 l 139 694 l 278 694 m 417 694 l 556 694 l 556 556 l 417 556 l 417 694 m 278 556 l 417 556 l 417 417 l 278 417 l 278 556 m 139 417 l 278 417 l 278 278 l 139 278 l 139 417 m 417 278 l 417 417 l 556 417 l 556 278 l 417 278 m 139 278 l 139 0 l 0 0 l 0 278 l 139 278 m 556 278 l 694 278 l 694 0 l 556 0 l 556 278 z "},"Y":{"ha":833,"x_min":0,"x_max":694,"o":"m 0 556 l 0 972 l 139 972 l 139 556 l 0 556 m 694 972 l 694 556 l 556 556 l 556 972 l 694 972 m 278 556 l 278 417 l 139 417 l 139 556 l 278 556 m 417 556 l 556 556 l 556 417 l 417 417 l 417 556 m 417 417 l 417 0 l 278 0 l 278 417 l 417 417 z "},"Ý":{"ha":833,"x_min":0,"x_max":694,"o":"m 0 556 l 0 972 l 139 972 l 139 556 l 0 556 m 694 972 l 694 556 l 556 556 l 556 972 l 694 972 m 278 556 l 278 417 l 139 417 l 139 556 l 278 556 m 417 556 l 556 556 l 556 417 l 417 417 l 417 556 m 417 417 l 417 0 l 278 0 l 278 417 l 417 417 z "},"Ŷ":{"ha":833,"x_min":0,"x_max":694,"o":"m 0 556 l 0 972 l 139 972 l 139 556 l 0 556 m 694 972 l 694 556 l 556 556 l 556 972 l 694 972 m 278 556 l 278 417 l 139 417 l 139 556 l 278 556 m 417 556 l 556 556 l 556 417 l 417 417 l 417 556 m 417 417 l 417 0 l 278 0 l 278 417 l 417 417 z "},"Ÿ":{"ha":833,"x_min":0,"x_max":694,"o":"m 0 556 l 0 972 l 139 972 l 139 556 l 0 556 m 694 972 l 694 556 l 556 556 l 556 972 l 694 972 m 278 556 l 278 417 l 139 417 l 139 556 l 278 556 m 417 556 l 556 556 l 556 417 l 417 417 l 417 556 m 417 417 l 417 0 l 278 0 l 278 417 l 417 417 z "},"Ỳ":{"ha":833,"x_min":0,"x_max":694,"o":"m 0 556 l 0 972 l 139 972 l 139 556 l 0 556 m 694 972 l 694 556 l 556 556 l 556 972 l 694 972 m 278 556 l 278 417 l 139 417 l 139 556 l 278 556 m 417 556 l 556 556 l 556 417 l 417 417 l 417 556 m 417 417 l 417 0 l 278 0 l 278 417 l 417 417 z "},"Z":{"ha":833,"x_min":0,"x_max":694,"o":"m 694 694 l 556 694 l 556 833 l 0 833 l 0 972 l 694 972 l 694 694 m 417 694 l 556 694 l 556 556 l 417 556 l 417 694 m 278 556 l 417 556 l 417 417 l 278 417 l 278 556 m 139 417 l 278 417 l 278 278 l 139 278 l 139 417 m 139 278 l 139 139 l 694 139 l 694 0 l 0 0 l 0 278 l 139 278 z "},"Ź":{"ha":833,"x_min":0,"x_max":694,"o":"m 694 694 l 556 694 l 556 833 l 0 833 l 0 972 l 694 972 l 694 694 m 417 694 l 556 694 l 556 556 l 417 556 l 417 694 m 278 556 l 417 556 l 417 417 l 278 417 l 278 556 m 139 417 l 278 417 l 278 278 l 139 278 l 139 417 m 139 278 l 139 139 l 694 139 l 694 0 l 0 0 l 0 278 l 139 278 z "},"Ž":{"ha":833,"x_min":0,"x_max":694,"o":"m 694 694 l 556 694 l 556 833 l 0 833 l 0 972 l 694 972 l 694 694 m 417 694 l 556 694 l 556 556 l 417 556 l 417 694 m 278 556 l 417 556 l 417 417 l 278 417 l 278 556 m 139 417 l 278 417 l 278 278 l 139 278 l 139 417 m 139 278 l 139 139 l 694 139 l 694 0 l 0 0 l 0 278 l 139 278 z "},"Ż":{"ha":833,"x_min":0,"x_max":694,"o":"m 694 694 l 556 694 l 556 833 l 0 833 l 0 972 l 694 972 l 694 694 m 417 694 l 556 694 l 556 556 l 417 556 l 417 694 m 278 556 l 417 556 l 417 417 l 278 417 l 278 556 m 139 417 l 278 417 l 278 278 l 139 278 l 139 417 m 139 278 l 139 139 l 694 139 l 694 0 l 0 0 l 0 278 l 139 278 z "},"a":{"ha":833,"x_min":0,"x_max":694,"o":"m 694 0 l 139 0 l 139 139 l 556 139 l 556 556 l 139 556 l 139 694 l 694 694 l 694 0 m 0 139 l 0 556 l 139 556 l 139 139 l 0 139 z "},"á":{"ha":833,"x_min":0,"x_max":694,"o":"m 694 0 l 139 0 l 139 139 l 556 139 l 556 556 l 139 556 l 139 694 l 694 694 l 694 0 m 0 139 l 0 556 l 139 556 l 139 139 l 0 139 m 417 1111 l 556 1111 l 556 972 l 417 972 l 417 1111 m 278 972 l 417 972 l 417 833 l 278 833 l 278 972 z "},"ă":{"ha":833,"x_min":0,"x_max":694,"o":"m 694 0 l 139 0 l 139 139 l 556 139 l 556 556 l 139 556 l 139 694 l 694 694 l 694 0 m 0 139 l 0 556 l 139 556 l 139 139 l 0 139 m 278 1111 l 278 972 l 139 972 l 139 1111 l 278 1111 m 694 1111 l 694 972 l 556 972 l 556 1111 l 694 1111 m 556 972 l 556 833 l 278 833 l 278 972 l 556 972 z "},"â":{"ha":833,"x_min":0,"x_max":694,"o":"m 694 0 l 139 0 l 139 139 l 556 139 l 556 556 l 139 556 l 139 694 l 694 694 l 694 0 m 0 139 l 0 556 l 139 556 l 139 139 l 0 139 m 278 1111 l 417 1111 l 417 972 l 278 972 l 278 1111 m 139 972 l 278 972 l 278 833 l 139 833 l 139 972 m 417 972 l 556 972 l 556 833 l 417 833 l 417 972 z "},"ä":{"ha":833,"x_min":0,"x_max":694,"o":"m 694 0 l 139 0 l 139 139 l 556 139 l 556 556 l 139 556 l 139 694 l 694 694 l 694 0 m 0 139 l 0 556 l 139 556 l 139 139 l 0 139 m 139 972 l 278 972 l 278 833 l 139 833 l 139 972 m 417 972 l 556 972 l 556 833 l 417 833 l 417 972 z "},"à":{"ha":833,"x_min":0,"x_max":694,"o":"m 694 0 l 139 0 l 139 139 l 556 139 l 556 556 l 139 556 l 139 694 l 694 694 l 694 0 m 0 139 l 0 556 l 139 556 l 139 139 l 0 139 m 139 1111 l 278 1111 l 278 972 l 139 972 l 139 1111 m 278 972 l 417 972 l 417 833 l 278 833 l 278 972 z "},"ā":{"ha":833,"x_min":0,"x_max":694,"o":"m 694 0 l 139 0 l 139 139 l 556 139 l 556 556 l 139 556 l 139 694 l 694 694 l 694 0 m 0 139 l 0 556 l 139 556 l 139 139 l 0 139 m 556 833 l 139 833 l 139 972 l 556 972 l 556 833 z "},"ą":{"ha":833,"x_min":0,"x_max":833,"o":"m 556 0 l 556 -139 l 417 -139 l 417 0 l 139 0 l 139 139 l 556 139 l 556 556 l 139 556 l 139 694 l 694 694 l 694 0 l 556 0 m 0 139 l 0 556 l 139 556 l 139 139 l 0 139 m 833 -278 l 556 -278 l 556 -139 l 833 -139 l 833 -278 z "},"å":{"ha":833,"x_min":0,"x_max":694,"o":"m 694 0 l 139 0 l 139 139 l 556 139 l 556 556 l 139 556 l 139 694 l 694 694 l 694 0 m 0 139 l 0 556 l 139 556 l 139 139 l 0 139 m 278 1250 l 417 1250 l 417 1111 l 278 1111 l 278 1250 m 139 1111 l 278 1111 l 278 972 l 139 972 l 139 1111 m 417 1111 l 556 1111 l 556 972 l 417 972 l 417 1111 m 278 972 l 417 972 l 417 833 l 278 833 l 278 972 z "},"ã":{"ha":833,"x_min":0,"x_max":694,"o":"m 694 0 l 139 0 l 139 139 l 556 139 l 556 556 l 139 556 l 139 694 l 694 694 l 694 0 m 0 139 l 0 556 l 139 556 l 139 139 l 0 139 m 139 1111 l 347 1111 l 347 972 l 139 972 l 139 1111 m 556 1111 l 694 1111 l 694 972 l 556 972 l 556 1111 m 0 972 l 139 972 l 139 833 l 0 833 l 0 972 m 347 972 l 556 972 l 556 833 l 347 833 l 347 972 z "},"æ":{"ha":833,"x_min":0,"x_max":694,"o":"m 278 556 l 0 556 l 0 694 l 278 694 l 278 556 m 556 556 l 417 556 l 417 694 l 556 694 l 556 556 m 694 556 l 694 278 l 417 278 l 417 139 l 278 139 l 278 278 l 139 278 l 139 139 l 0 139 l 0 417 l 278 417 l 278 556 l 417 556 l 417 417 l 556 417 l 556 556 l 694 556 m 139 139 l 278 139 l 278 0 l 139 0 l 139 139 m 417 139 l 694 139 l 694 0 l 417 0 l 417 139 z "},"b":{"ha":833,"x_min":0,"x_max":694,"o":"m 556 0 l 0 0 l 0 972 l 139 972 l 139 694 l 556 694 l 556 556 l 139 556 l 139 139 l 556 139 l 556 0 m 694 556 l 694 139 l 556 139 l 556 556 l 694 556 z "},"c":{"ha":833,"x_min":0,"x_max":694,"o":"m 556 556 l 139 556 l 139 694 l 556 694 l 556 556 m 139 556 l 139 139 l 0 139 l 0 556 l 139 556 m 556 417 l 556 556 l 694 556 l 694 417 l 556 417 m 694 139 l 556 139 l 556 278 l 694 278 l 694 139 m 139 139 l 556 139 l 556 0 l 139 0 l 139 139 z "},"ć":{"ha":833,"x_min":0,"x_max":694,"o":"m 556 556 l 139 556 l 139 694 l 556 694 l 556 556 m 139 556 l 139 139 l 0 139 l 0 556 l 139 556 m 556 417 l 556 556 l 694 556 l 694 417 l 556 417 m 694 139 l 556 139 l 556 278 l 694 278 l 694 139 m 139 139 l 556 139 l 556 0 l 139 0 l 139 139 m 417 1111 l 556 1111 l 556 972 l 417 972 l 417 1111 m 278 972 l 417 972 l 417 833 l 278 833 l 278 972 z "},"č":{"ha":833,"x_min":0,"x_max":694,"o":"m 556 556 l 139 556 l 139 694 l 556 694 l 556 556 m 139 556 l 139 139 l 0 139 l 0 556 l 139 556 m 556 417 l 556 556 l 694 556 l 694 417 l 556 417 m 694 139 l 556 139 l 556 278 l 694 278 l 694 139 m 139 139 l 556 139 l 556 0 l 139 0 l 139 139 m 139 1111 l 278 1111 l 278 972 l 139 972 l 139 1111 m 417 1111 l 556 1111 l 556 972 l 417 972 l 417 1111 m 278 972 l 417 972 l 417 833 l 278 833 l 278 972 z "},"ç":{"ha":833,"x_min":0,"x_max":694,"o":"m 556 556 l 139 556 l 139 694 l 556 694 l 556 556 m 139 556 l 139 139 l 0 139 l 0 556 l 139 556 m 556 417 l 556 556 l 694 556 l 694 417 l 556 417 m 694 139 l 556 139 l 556 278 l 694 278 l 694 139 m 139 139 l 556 139 l 556 -139 l 417 -139 l 417 0 l 139 0 l 139 139 m 417 -139 l 417 -278 l 139 -278 l 139 -139 l 417 -139 z "},"ċ":{"ha":833,"x_min":0,"x_max":694,"o":"m 556 556 l 139 556 l 139 694 l 556 694 l 556 556 m 139 556 l 139 139 l 0 139 l 0 556 l 139 556 m 556 417 l 556 556 l 694 556 l 694 417 l 556 417 m 694 139 l 556 139 l 556 278 l 694 278 l 694 139 m 139 139 l 556 139 l 556 0 l 139 0 l 139 139 m 278 972 l 417 972 l 417 833 l 278 833 l 278 972 z "},"d":{"ha":833,"x_min":0,"x_max":694,"o":"m 694 972 l 694 0 l 139 0 l 139 139 l 556 139 l 556 556 l 139 556 l 139 694 l 556 694 l 556 972 l 694 972 m 0 139 l 0 556 l 139 556 l 139 139 l 0 139 z "},"ð":{"ha":833,"x_min":0,"x_max":833,"o":"m 833 694 l 694 694 l 694 139 l 556 139 l 556 417 l 139 417 l 139 556 l 556 556 l 556 694 l 278 694 l 278 833 l 417 833 l 417 972 l 556 972 l 556 833 l 833 833 l 833 694 m 139 139 l 0 139 l 0 417 l 139 417 l 139 139 m 556 0 l 139 0 l 139 139 l 556 139 l 556 0 z "},"ď":{"ha":833,"x_min":0,"x_max":764,"o":"m 764 1111 l 764 833 l 625 833 l 625 1111 l 764 1111 m 556 972 l 556 0 l 139 0 l 139 139 l 417 139 l 417 556 l 139 556 l 139 694 l 417 694 l 417 972 l 556 972 m 0 139 l 0 556 l 139 556 l 139 139 l 0 139 z "},"đ":{"ha":833,"x_min":0,"x_max":833,"o":"m 833 833 l 833 694 l 694 694 l 694 0 l 139 0 l 139 139 l 556 139 l 556 417 l 139 417 l 139 556 l 556 556 l 556 694 l 278 694 l 278 833 l 556 833 l 556 972 l 694 972 l 694 833 l 833 833 m 139 139 l 0 139 l 0 417 l 139 417 l 139 139 z "},"e":{"ha":833,"x_min":0,"x_max":694,"o":"m 139 694 l 556 694 l 556 556 l 139 556 l 139 694 m 694 556 l 694 278 l 139 278 l 139 139 l 0 139 l 0 556 l 139 556 l 139 417 l 556 417 l 556 556 l 694 556 m 139 139 l 556 139 l 556 0 l 139 0 l 139 139 z "},"é":{"ha":833,"x_min":0,"x_max":694,"o":"m 139 694 l 556 694 l 556 556 l 139 556 l 139 694 m 694 556 l 694 278 l 139 278 l 139 139 l 0 139 l 0 556 l 139 556 l 139 417 l 556 417 l 556 556 l 694 556 m 139 139 l 556 139 l 556 0 l 139 0 l 139 139 m 417 1111 l 556 1111 l 556 972 l 417 972 l 417 1111 m 278 972 l 417 972 l 417 833 l 278 833 l 278 972 z "},"ě":{"ha":833,"x_min":0,"x_max":694,"o":"m 139 694 l 556 694 l 556 556 l 139 556 l 139 694 m 694 556 l 694 278 l 139 278 l 139 139 l 0 139 l 0 556 l 139 556 l 139 417 l 556 417 l 556 556 l 694 556 m 139 139 l 556 139 l 556 0 l 139 0 l 139 139 m 139 1111 l 278 1111 l 278 972 l 139 972 l 139 1111 m 417 1111 l 556 1111 l 556 972 l 417 972 l 417 1111 m 278 972 l 417 972 l 417 833 l 278 833 l 278 972 z "},"ê":{"ha":833,"x_min":0,"x_max":694,"o":"m 139 694 l 556 694 l 556 556 l 139 556 l 139 694 m 694 556 l 694 278 l 139 278 l 139 139 l 0 139 l 0 556 l 139 556 l 139 417 l 556 417 l 556 556 l 694 556 m 139 139 l 556 139 l 556 0 l 139 0 l 139 139 m 278 1111 l 417 1111 l 417 972 l 278 972 l 278 1111 m 139 972 l 278 972 l 278 833 l 139 833 l 139 972 m 417 972 l 556 972 l 556 833 l 417 833 l 417 972 z "},"ë":{"ha":833,"x_min":0,"x_max":694,"o":"m 139 694 l 556 694 l 556 556 l 139 556 l 139 694 m 694 556 l 694 278 l 139 278 l 139 139 l 0 139 l 0 556 l 139 556 l 139 417 l 556 417 l 556 556 l 694 556 m 139 139 l 556 139 l 556 0 l 139 0 l 139 139 m 139 972 l 278 972 l 278 833 l 139 833 l 139 972 m 417 972 l 556 972 l 556 833 l 417 833 l 417 972 z "},"ė":{"ha":833,"x_min":0,"x_max":694,"o":"m 139 694 l 556 694 l 556 556 l 139 556 l 139 694 m 694 556 l 694 278 l 139 278 l 139 139 l 0 139 l 0 556 l 139 556 l 139 417 l 556 417 l 556 556 l 694 556 m 139 139 l 556 139 l 556 0 l 139 0 l 139 139 m 278 972 l 417 972 l 417 833 l 278 833 l 278 972 z "},"è":{"ha":833,"x_min":0,"x_max":694,"o":"m 139 694 l 556 694 l 556 556 l 139 556 l 139 694 m 694 556 l 694 278 l 139 278 l 139 139 l 0 139 l 0 556 l 139 556 l 139 417 l 556 417 l 556 556 l 694 556 m 139 139 l 556 139 l 556 0 l 139 0 l 139 139 m 139 1111 l 278 1111 l 278 972 l 139 972 l 139 1111 m 278 972 l 417 972 l 417 833 l 278 833 l 278 972 z "},"ē":{"ha":833,"x_min":0,"x_max":694,"o":"m 139 694 l 556 694 l 556 556 l 139 556 l 139 694 m 694 556 l 694 278 l 139 278 l 139 139 l 0 139 l 0 556 l 139 556 l 139 417 l 556 417 l 556 556 l 694 556 m 139 139 l 556 139 l 556 0 l 139 0 l 139 139 m 556 833 l 139 833 l 139 972 l 556 972 l 556 833 z "},"ę":{"ha":833,"x_min":0,"x_max":833,"o":"m 139 694 l 556 694 l 556 556 l 139 556 l 139 694 m 139 139 l 0 139 l 0 556 l 139 556 l 139 417 l 556 417 l 556 556 l 694 556 l 694 278 l 139 278 l 139 139 m 556 0 l 556 -139 l 417 -139 l 417 0 l 139 0 l 139 139 l 694 139 l 694 0 l 556 0 m 833 -278 l 556 -278 l 556 -139 l 833 -139 l 833 -278 z "},"f":{"ha":833,"x_min":139,"x_max":556,"o":"m 278 833 l 278 972 l 556 972 l 556 833 l 278 833 m 278 556 l 556 556 l 556 417 l 278 417 l 278 0 l 139 0 l 139 833 l 278 833 l 278 556 z "},"g":{"ha":833,"x_min":0,"x_max":694,"o":"m 694 -139 l 556 -139 l 556 0 l 139 0 l 139 139 l 556 139 l 556 556 l 139 556 l 139 694 l 694 694 l 694 -139 m 0 139 l 0 556 l 139 556 l 139 139 l 0 139 m 556 -278 l 139 -278 l 139 -139 l 556 -139 l 556 -278 z "},"ğ":{"ha":833,"x_min":0,"x_max":694,"o":"m 694 -139 l 556 -139 l 556 0 l 139 0 l 139 139 l 556 139 l 556 556 l 139 556 l 139 694 l 694 694 l 694 -139 m 0 139 l 0 556 l 139 556 l 139 139 l 0 139 m 556 -278 l 139 -278 l 139 -139 l 556 -139 l 556 -278 m 278 1111 l 278 972 l 139 972 l 139 1111 l 278 1111 m 694 1111 l 694 972 l 556 972 l 556 1111 l 694 1111 m 556 972 l 556 833 l 278 833 l 278 972 l 556 972 z "},"ģ":{"ha":833,"x_min":0,"x_max":694,"o":"m 694 -139 l 556 -139 l 556 0 l 139 0 l 139 139 l 556 139 l 556 556 l 139 556 l 139 694 l 694 694 l 694 -139 m 0 139 l 0 556 l 139 556 l 139 139 l 0 139 m 556 -278 l 139 -278 l 139 -139 l 556 -139 l 556 -278 m 417 1111 l 556 1111 l 556 972 l 417 972 l 417 1111 m 278 972 l 417 972 l 417 833 l 278 833 l 278 972 z "},"ġ":{"ha":833,"x_min":0,"x_max":694,"o":"m 694 -139 l 556 -139 l 556 0 l 139 0 l 139 139 l 556 139 l 556 556 l 139 556 l 139 694 l 694 694 l 694 -139 m 0 139 l 0 556 l 139 556 l 139 139 l 0 139 m 556 -278 l 139 -278 l 139 -139 l 556 -139 l 556 -278 m 278 972 l 417 972 l 417 833 l 278 833 l 278 972 z "},"h":{"ha":833,"x_min":0,"x_max":694,"o":"m 556 556 l 139 556 l 139 0 l 0 0 l 0 972 l 139 972 l 139 694 l 556 694 l 556 556 m 694 556 l 694 0 l 556 0 l 556 556 l 694 556 z "},"ħ":{"ha":833,"x_min":-139,"x_max":694,"o":"m 556 417 l 139 417 l 139 0 l 0 0 l 0 694 l -139 694 l -139 833 l 0 833 l 0 972 l 139 972 l 139 833 l 417 833 l 417 694 l 139 694 l 139 556 l 556 556 l 556 417 m 694 417 l 694 0 l 556 0 l 556 417 l 694 417 z "},"i":{"ha":833,"x_min":139,"x_max":556,"o":"m 417 833 l 278 833 l 278 972 l 417 972 l 417 833 m 556 139 l 556 0 l 139 0 l 139 139 l 278 139 l 278 556 l 139 556 l 139 694 l 417 694 l 417 139 l 556 139 z "},"ı":{"ha":833,"x_min":139,"x_max":556,"o":"m 556 139 l 556 0 l 139 0 l 139 139 l 278 139 l 278 556 l 139 556 l 139 694 l 417 694 l 417 139 l 556 139 z "},"í":{"ha":833,"x_min":139,"x_max":556,"o":"m 556 139 l 556 0 l 139 0 l 139 139 l 278 139 l 278 556 l 139 556 l 139 694 l 417 694 l 417 139 l 556 139 m 417 1111 l 556 1111 l 556 972 l 417 972 l 417 1111 m 278 972 l 417 972 l 417 833 l 278 833 l 278 972 z "},"î":{"ha":833,"x_min":139,"x_max":556,"o":"m 556 139 l 556 0 l 139 0 l 139 139 l 278 139 l 278 556 l 139 556 l 139 694 l 417 694 l 417 139 l 556 139 m 278 1111 l 417 1111 l 417 972 l 278 972 l 278 1111 m 139 972 l 278 972 l 278 833 l 139 833 l 139 972 m 417 972 l 556 972 l 556 833 l 417 833 l 417 972 z "},"ï":{"ha":833,"x_min":139,"x_max":556,"o":"m 556 139 l 556 0 l 139 0 l 139 139 l 278 139 l 278 556 l 139 556 l 139 694 l 417 694 l 417 139 l 556 139 m 139 972 l 278 972 l 278 833 l 139 833 l 139 972 m 417 972 l 556 972 l 556 833 l 417 833 l 417 972 z "},"ì":{"ha":833,"x_min":139,"x_max":556,"o":"m 556 139 l 556 0 l 139 0 l 139 139 l 278 139 l 278 556 l 139 556 l 139 694 l 417 694 l 417 139 l 556 139 m 139 1111 l 278 1111 l 278 972 l 139 972 l 139 1111 m 278 972 l 417 972 l 417 833 l 278 833 l 278 972 z "},"ĳ":{"ha":833,"x_min":0,"x_max":694,"o":"m 278 833 l 139 833 l 139 972 l 278 972 l 278 833 m 417 139 l 417 0 l 0 0 l 0 139 l 139 139 l 139 556 l 0 556 l 0 694 l 278 694 l 278 139 l 417 139 m 694 972 l 694 833 l 556 833 l 556 972 l 694 972 m 694 694 l 694 -139 l 556 -139 l 556 556 l 417 556 l 417 694 l 694 694 m 556 -139 l 556 -278 l 278 -278 l 278 -139 l 556 -139 z "},"ī":{"ha":833,"x_min":139,"x_max":556,"o":"m 556 139 l 556 0 l 139 0 l 139 139 l 278 139 l 278 556 l 139 556 l 139 694 l 417 694 l 417 139 l 556 139 m 556 833 l 139 833 l 139 972 l 556 972 l 556 833 z "},"į":{"ha":833,"x_min":139,"x_max":694,"o":"m 417 833 l 278 833 l 278 972 l 417 972 l 417 833 m 417 0 l 417 -139 l 278 -139 l 278 0 l 139 0 l 139 139 l 278 139 l 278 556 l 139 556 l 139 694 l 417 694 l 417 139 l 556 139 l 556 0 l 417 0 m 694 -278 l 417 -278 l 417 -139 l 694 -139 l 694 -278 z "},"j":{"ha":833,"x_min":0,"x_max":417,"o":"m 417 972 l 417 833 l 278 833 l 278 972 l 417 972 m 417 694 l 417 -139 l 278 -139 l 278 556 l 139 556 l 139 694 l 417 694 m 278 -139 l 278 -278 l 0 -278 l 0 -139 l 278 -139 z "},"ȷ":{"ha":833,"x_min":0,"x_max":417,"o":"m 417 -139 l 278 -139 l 278 556 l 139 556 l 139 694 l 417 694 l 417 -139 m 278 -139 l 278 -278 l 0 -278 l 0 -139 l 278 -139 z "},"k":{"ha":833,"x_min":0,"x_max":694,"o":"m 417 278 l 139 278 l 139 0 l 0 0 l 0 972 l 139 972 l 139 417 l 278 417 l 278 556 l 417 556 l 417 278 m 556 556 l 417 556 l 417 694 l 556 694 l 556 556 m 556 278 l 556 139 l 417 139 l 417 278 l 556 278 m 694 139 l 694 0 l 556 0 l 556 139 l 694 139 z "},"ķ":{"ha":833,"x_min":0,"x_max":694,"o":"m 417 278 l 139 278 l 139 0 l 0 0 l 0 972 l 139 972 l 139 417 l 278 417 l 278 556 l 417 556 l 417 278 m 556 556 l 417 556 l 417 694 l 556 694 l 556 556 m 556 278 l 556 139 l 417 139 l 417 278 l 556 278 m 694 139 l 694 0 l 556 0 l 556 139 l 694 139 m 278 -139 l 417 -139 l 417 -278 l 278 -278 l 278 -139 m 139 -278 l 278 -278 l 278 -417 l 139 -417 l 139 -278 z "},"l":{"ha":833,"x_min":139,"x_max":556,"o":"m 139 139 l 139 972 l 278 972 l 278 139 l 139 139 m 556 0 l 278 0 l 278 139 l 556 139 l 556 0 z "},"ĺ":{"ha":833,"x_min":139,"x_max":556,"o":"m 139 139 l 139 972 l 278 972 l 278 139 l 139 139 m 556 0 l 278 0 l 278 139 l 556 139 l 556 0 m 278 1389 l 417 1389 l 417 1250 l 278 1250 l 278 1389 m 139 1250 l 278 1250 l 278 1111 l 139 1111 l 139 1250 z "},"ľ":{"ha":833,"x_min":139,"x_max":694,"o":"m 694 1111 l 694 833 l 556 833 l 556 1111 l 694 1111 m 139 139 l 139 972 l 278 972 l 278 139 l 139 139 m 417 833 l 556 833 l 556 694 l 417 694 l 417 833 m 556 139 l 556 0 l 278 0 l 278 139 l 556 139 z "},"ļ":{"ha":833,"x_min":139,"x_max":556,"o":"m 139 139 l 139 972 l 278 972 l 278 139 l 139 139 m 556 0 l 278 0 l 278 139 l 556 139 l 556 0 m 278 -139 l 417 -139 l 417 -278 l 278 -278 l 278 -139 m 139 -278 l 278 -278 l 278 -417 l 139 -417 l 139 -278 z "},"ł":{"ha":833,"x_min":0,"x_max":556,"o":"m 278 139 l 139 139 l 139 278 l 0 278 l 0 417 l 139 417 l 139 972 l 278 972 l 278 556 l 417 556 l 417 417 l 278 417 l 278 139 m 556 0 l 278 0 l 278 139 l 556 139 l 556 0 z "},"m":{"ha":833,"x_min":0,"x_max":694,"o":"m 556 556 l 417 556 l 417 0 l 278 0 l 278 556 l 139 556 l 139 0 l 0 0 l 0 694 l 556 694 l 556 556 m 694 556 l 694 0 l 556 0 l 556 556 l 694 556 z "},"n":{"ha":833,"x_min":0,"x_max":694,"o":"m 556 556 l 139 556 l 139 0 l 0 0 l 0 694 l 556 694 l 556 556 m 694 556 l 694 0 l 556 0 l 556 556 l 694 556 z "},"ń":{"ha":833,"x_min":0,"x_max":694,"o":"m 556 556 l 139 556 l 139 0 l 0 0 l 0 694 l 556 694 l 556 556 m 694 556 l 694 0 l 556 0 l 556 556 l 694 556 m 417 1111 l 556 1111 l 556 972 l 417 972 l 417 1111 m 278 972 l 417 972 l 417 833 l 278 833 l 278 972 z "},"ň":{"ha":833,"x_min":0,"x_max":694,"o":"m 556 556 l 139 556 l 139 0 l 0 0 l 0 694 l 556 694 l 556 556 m 694 556 l 694 0 l 556 0 l 556 556 l 694 556 m 139 1111 l 278 1111 l 278 972 l 139 972 l 139 1111 m 417 1111 l 556 1111 l 556 972 l 417 972 l 417 1111 m 278 972 l 417 972 l 417 833 l 278 833 l 278 972 z "},"ņ":{"ha":833,"x_min":0,"x_max":694,"o":"m 556 556 l 139 556 l 139 0 l 0 0 l 0 694 l 556 694 l 556 556 m 694 556 l 694 0 l 556 0 l 556 556 l 694 556 m 278 -139 l 417 -139 l 417 -278 l 278 -278 l 278 -139 m 139 -278 l 278 -278 l 278 -417 l 139 -417 l 139 -278 z "},"ŋ":{"ha":833,"x_min":0,"x_max":694,"o":"m 556 556 l 139 556 l 139 0 l 0 0 l 0 694 l 556 694 l 556 556 m 694 556 l 694 -139 l 556 -139 l 556 556 l 694 556 m 556 -139 l 556 -278 l 278 -278 l 278 -139 l 556 -139 z "},"ñ":{"ha":833,"x_min":0,"x_max":694,"o":"m 556 556 l 139 556 l 139 0 l 0 0 l 0 694 l 556 694 l 556 556 m 694 556 l 694 0 l 556 0 l 556 556 l 694 556 m 139 1111 l 347 1111 l 347 972 l 139 972 l 139 1111 m 556 1111 l 694 1111 l 694 972 l 556 972 l 556 1111 m 0 972 l 139 972 l 139 833 l 0 833 l 0 972 m 347 972 l 556 972 l 556 833 l 347 833 l 347 972 z "},"o":{"ha":833,"x_min":0,"x_max":694,"o":"m 139 694 l 556 694 l 556 556 l 139 556 l 139 694 m 0 139 l 0 556 l 139 556 l 139 139 l 0 139 m 694 556 l 694 139 l 556 139 l 556 556 l 694 556 m 556 0 l 139 0 l 139 139 l 556 139 l 556 0 z "},"ó":{"ha":833,"x_min":0,"x_max":694,"o":"m 139 694 l 556 694 l 556 556 l 139 556 l 139 694 m 0 139 l 0 556 l 139 556 l 139 139 l 0 139 m 694 556 l 694 139 l 556 139 l 556 556 l 694 556 m 556 0 l 139 0 l 139 139 l 556 139 l 556 0 m 417 1111 l 556 1111 l 556 972 l 417 972 l 417 1111 m 278 972 l 417 972 l 417 833 l 278 833 l 278 972 z "},"ô":{"ha":833,"x_min":0,"x_max":694,"o":"m 139 694 l 556 694 l 556 556 l 139 556 l 139 694 m 0 139 l 0 556 l 139 556 l 139 139 l 0 139 m 694 556 l 694 139 l 556 139 l 556 556 l 694 556 m 556 0 l 139 0 l 139 139 l 556 139 l 556 0 m 278 1111 l 417 1111 l 417 972 l 278 972 l 278 1111 m 139 972 l 278 972 l 278 833 l 139 833 l 139 972 m 417 972 l 556 972 l 556 833 l 417 833 l 417 972 z "},"ö":{"ha":833,"x_min":0,"x_max":694,"o":"m 139 694 l 556 694 l 556 556 l 139 556 l 139 694 m 0 139 l 0 556 l 139 556 l 139 139 l 0 139 m 694 556 l 694 139 l 556 139 l 556 556 l 694 556 m 556 0 l 139 0 l 139 139 l 556 139 l 556 0 m 139 972 l 278 972 l 278 833 l 139 833 l 139 972 m 417 972 l 556 972 l 556 833 l 417 833 l 417 972 z "},"ò":{"ha":833,"x_min":0,"x_max":694,"o":"m 139 694 l 556 694 l 556 556 l 139 556 l 139 694 m 0 139 l 0 556 l 139 556 l 139 139 l 0 139 m 694 556 l 694 139 l 556 139 l 556 556 l 694 556 m 556 0 l 139 0 l 139 139 l 556 139 l 556 0 m 139 1111 l 278 1111 l 278 972 l 139 972 l 139 1111 m 278 972 l 417 972 l 417 833 l 278 833 l 278 972 z "},"ő":{"ha":833,"x_min":0,"x_max":694,"o":"m 139 694 l 556 694 l 556 556 l 139 556 l 139 694 m 0 139 l 0 556 l 139 556 l 139 139 l 0 139 m 694 556 l 694 139 l 556 139 l 556 556 l 694 556 m 556 0 l 139 0 l 139 139 l 556 139 l 556 0 m 278 1111 l 417 1111 l 417 972 l 278 972 l 278 1111 m 556 1111 l 694 1111 l 694 972 l 556 972 l 556 1111 m 139 972 l 278 972 l 278 833 l 139 833 l 139 972 m 417 972 l 556 972 l 556 833 l 417 833 l 417 972 z "},"ō":{"ha":833,"x_min":0,"x_max":694,"o":"m 139 694 l 556 694 l 556 556 l 139 556 l 139 694 m 0 139 l 0 556 l 139 556 l 139 139 l 0 139 m 694 556 l 694 139 l 556 139 l 556 556 l 694 556 m 556 0 l 139 0 l 139 139 l 556 139 l 556 0 m 556 833 l 139 833 l 139 972 l 556 972 l 556 833 z "},"ø":{"ha":833,"x_min":0,"x_max":694,"o":"m 694 556 l 694 139 l 556 139 l 556 417 l 417 417 l 417 556 l 139 556 l 139 694 l 556 694 l 556 556 l 694 556 m 556 139 l 556 0 l 139 0 l 139 139 l 0 139 l 0 556 l 139 556 l 139 278 l 278 278 l 278 139 l 556 139 m 278 417 l 417 417 l 417 278 l 278 278 l 278 417 z "},"õ":{"ha":833,"x_min":0,"x_max":694,"o":"m 139 694 l 556 694 l 556 556 l 139 556 l 139 694 m 0 139 l 0 556 l 139 556 l 139 139 l 0 139 m 694 556 l 694 139 l 556 139 l 556 556 l 694 556 m 556 0 l 139 0 l 139 139 l 556 139 l 556 0 m 139 1111 l 347 1111 l 347 972 l 139 972 l 139 1111 m 556 1111 l 694 1111 l 694 972 l 556 972 l 556 1111 m 0 972 l 139 972 l 139 833 l 0 833 l 0 972 m 347 972 l 556 972 l 556 833 l 347 833 l 347 972 z "},"œ":{"ha":833,"x_min":0,"x_max":694,"o":"m 278 556 l 139 556 l 139 694 l 278 694 l 278 556 m 556 556 l 417 556 l 417 694 l 556 694 l 556 556 m 0 139 l 0 556 l 139 556 l 139 139 l 0 139 m 694 556 l 694 278 l 417 278 l 417 139 l 278 139 l 278 556 l 417 556 l 417 417 l 556 417 l 556 556 l 694 556 m 139 139 l 278 139 l 278 0 l 139 0 l 139 139 m 417 139 l 694 139 l 694 0 l 417 0 l 417 139 z "},"p":{"ha":833,"x_min":0,"x_max":694,"o":"m 556 0 l 139 0 l 139 -278 l 0 -278 l 0 694 l 556 694 l 556 556 l 139 556 l 139 139 l 556 139 l 556 0 m 694 556 l 694 139 l 556 139 l 556 556 l 694 556 z "},"þ":{"ha":833,"x_min":0,"x_max":694,"o":"m 556 0 l 139 0 l 139 -278 l 0 -278 l 0 972 l 139 972 l 139 694 l 556 694 l 556 556 l 139 556 l 139 139 l 556 139 l 556 0 m 694 556 l 694 139 l 556 139 l 556 556 l 694 556 z "},"q":{"ha":833,"x_min":0,"x_max":694,"o":"m 694 -278 l 556 -278 l 556 0 l 139 0 l 139 139 l 556 139 l 556 556 l 139 556 l 139 694 l 694 694 l 694 -278 m 0 139 l 0 556 l 139 556 l 139 139 l 0 139 z "},"r":{"ha":833,"x_min":0,"x_max":694,"o":"m 139 556 l 278 556 l 278 417 l 139 417 l 139 0 l 0 0 l 0 694 l 139 694 l 139 556 m 556 556 l 278 556 l 278 694 l 556 694 l 556 556 m 694 556 l 694 417 l 556 417 l 556 556 l 694 556 z "},"ŕ":{"ha":833,"x_min":0,"x_max":694,"o":"m 139 556 l 278 556 l 278 417 l 139 417 l 139 0 l 0 0 l 0 694 l 139 694 l 139 556 m 556 556 l 278 556 l 278 694 l 556 694 l 556 556 m 694 556 l 694 417 l 556 417 l 556 556 l 694 556 m 417 1111 l 556 1111 l 556 972 l 417 972 l 417 1111 m 278 972 l 417 972 l 417 833 l 278 833 l 278 972 z "},"ř":{"ha":833,"x_min":0,"x_max":694,"o":"m 139 556 l 278 556 l 278 417 l 139 417 l 139 0 l 0 0 l 0 694 l 139 694 l 139 556 m 556 556 l 278 556 l 278 694 l 556 694 l 556 556 m 694 556 l 694 417 l 556 417 l 556 556 l 694 556 m 139 1111 l 278 1111 l 278 972 l 139 972 l 139 1111 m 417 1111 l 556 1111 l 556 972 l 417 972 l 417 1111 m 278 972 l 417 972 l 417 833 l 278 833 l 278 972 z "},"ŗ":{"ha":833,"x_min":0,"x_max":694,"o":"m 139 556 l 278 556 l 278 417 l 139 417 l 139 0 l 0 0 l 0 694 l 139 694 l 139 556 m 556 556 l 278 556 l 278 694 l 556 694 l 556 556 m 694 556 l 694 417 l 556 417 l 556 556 l 694 556 m 139 -139 l 278 -139 l 278 -278 l 139 -278 l 139 -139 m 0 -278 l 139 -278 l 139 -417 l 0 -417 l 0 -278 z "},"s":{"ha":833,"x_min":0,"x_max":694,"o":"m 139 694 l 694 694 l 694 556 l 139 556 l 139 694 m 139 556 l 139 417 l 0 417 l 0 556 l 139 556 m 139 417 l 556 417 l 556 278 l 139 278 l 139 417 m 556 139 l 556 278 l 694 278 l 694 139 l 556 139 m 556 0 l 0 0 l 0 139 l 556 139 l 556 0 z "},"ś":{"ha":833,"x_min":0,"x_max":694,"o":"m 139 694 l 694 694 l 694 556 l 139 556 l 139 694 m 139 556 l 139 417 l 0 417 l 0 556 l 139 556 m 139 417 l 556 417 l 556 278 l 139 278 l 139 417 m 556 139 l 556 278 l 694 278 l 694 139 l 556 139 m 556 0 l 0 0 l 0 139 l 556 139 l 556 0 m 417 1111 l 556 1111 l 556 972 l 417 972 l 417 1111 m 278 972 l 417 972 l 417 833 l 278 833 l 278 972 z "},"š":{"ha":833,"x_min":0,"x_max":694,"o":"m 139 694 l 694 694 l 694 556 l 139 556 l 139 694 m 139 556 l 139 417 l 0 417 l 0 556 l 139 556 m 139 417 l 556 417 l 556 278 l 139 278 l 139 417 m 556 139 l 556 278 l 694 278 l 694 139 l 556 139 m 556 0 l 0 0 l 0 139 l 556 139 l 556 0 m 139 1111 l 278 1111 l 278 972 l 139 972 l 139 1111 m 417 1111 l 556 1111 l 556 972 l 417 972 l 417 1111 m 278 972 l 417 972 l 417 833 l 278 833 l 278 972 z "},"ş":{"ha":833,"x_min":0,"x_max":694,"o":"m 139 694 l 694 694 l 694 556 l 139 556 l 139 694 m 139 556 l 139 417 l 0 417 l 0 556 l 139 556 m 139 417 l 556 417 l 556 278 l 139 278 l 139 417 m 556 139 l 556 278 l 694 278 l 694 139 l 556 139 m 556 -139 l 417 -139 l 417 0 l 0 0 l 0 139 l 556 139 l 556 -139 m 417 -139 l 417 -278 l 139 -278 l 139 -139 l 417 -139 z "},"ș":{"ha":833,"x_min":0,"x_max":694,"o":"m 139 694 l 694 694 l 694 556 l 139 556 l 139 694 m 139 556 l 139 417 l 0 417 l 0 556 l 139 556 m 139 417 l 556 417 l 556 278 l 139 278 l 139 417 m 556 139 l 556 278 l 694 278 l 694 139 l 556 139 m 556 0 l 0 0 l 0 139 l 556 139 l 556 0 m 278 -139 l 417 -139 l 417 -278 l 278 -278 l 278 -139 m 139 -278 l 278 -278 l 278 -417 l 139 -417 l 139 -278 z "},"ß":{"ha":833,"x_min":0,"x_max":694,"o":"m 417 833 l 139 833 l 139 972 l 417 972 l 417 833 m 139 833 l 139 0 l 0 0 l 0 833 l 139 833 m 278 417 l 278 556 l 417 556 l 417 833 l 556 833 l 556 417 l 278 417 m 694 417 l 694 139 l 556 139 l 556 417 l 694 417 m 556 139 l 556 0 l 278 0 l 278 139 l 556 139 z "},"ſ":{"ha":833,"x_min":139,"x_max":694,"o":"m 694 833 l 417 833 l 417 972 l 694 972 l 694 833 m 417 833 l 417 0 l 278 0 l 278 417 l 139 417 l 139 556 l 278 556 l 278 833 l 417 833 z "},"t":{"ha":833,"x_min":0,"x_max":556,"o":"m 139 139 l 139 556 l 0 556 l 0 694 l 139 694 l 139 972 l 278 972 l 278 694 l 556 694 l 556 556 l 278 556 l 278 139 l 139 139 m 278 139 l 556 139 l 556 0 l 278 0 l 278 139 z "},"ŧ":{"ha":833,"x_min":0,"x_max":556,"o":"m 278 556 l 556 556 l 556 417 l 278 417 l 278 139 l 139 139 l 139 417 l 0 417 l 0 556 l 139 556 l 139 694 l 0 694 l 0 833 l 139 833 l 139 972 l 278 972 l 278 833 l 556 833 l 556 694 l 278 694 l 278 556 m 278 139 l 556 139 l 556 0 l 278 0 l 278 139 z "},"ť":{"ha":833,"x_min":0,"x_max":694,"o":"m 694 1111 l 694 833 l 556 833 l 556 1111 l 694 1111 m 556 694 l 556 556 l 278 556 l 278 139 l 139 139 l 139 556 l 0 556 l 0 694 l 139 694 l 139 972 l 278 972 l 278 694 l 556 694 m 278 139 l 556 139 l 556 0 l 278 0 l 278 139 z "},"ţ":{"ha":833,"x_min":0,"x_max":556,"o":"m 139 139 l 139 556 l 0 556 l 0 694 l 139 694 l 139 972 l 278 972 l 278 694 l 556 694 l 556 556 l 278 556 l 278 139 l 139 139 m 278 0 l 278 139 l 556 139 l 556 -139 l 417 -139 l 417 0 l 278 0 m 417 -139 l 417 -278 l 139 -278 l 139 -139 l 417 -139 z "},"ț":{"ha":833,"x_min":0,"x_max":556,"o":"m 139 139 l 139 556 l 0 556 l 0 694 l 139 694 l 139 972 l 278 972 l 278 694 l 556 694 l 556 556 l 278 556 l 278 139 l 139 139 m 278 139 l 556 139 l 556 0 l 278 0 l 278 139 m 278 -139 l 417 -139 l 417 -278 l 278 -278 l 278 -139 m 139 -278 l 278 -278 l 278 -417 l 139 -417 l 139 -278 z "},"u":{"ha":833,"x_min":0,"x_max":694,"o":"m 0 139 l 0 694 l 139 694 l 139 139 l 0 139 m 694 694 l 694 0 l 139 0 l 139 139 l 556 139 l 556 694 l 694 694 z "},"ú":{"ha":833,"x_min":0,"x_max":694,"o":"m 0 139 l 0 694 l 139 694 l 139 139 l 0 139 m 694 694 l 694 0 l 139 0 l 139 139 l 556 139 l 556 694 l 694 694 m 417 1111 l 556 1111 l 556 972 l 417 972 l 417 1111 m 278 972 l 417 972 l 417 833 l 278 833 l 278 972 z "},"û":{"ha":833,"x_min":0,"x_max":694,"o":"m 0 139 l 0 694 l 139 694 l 139 139 l 0 139 m 694 694 l 694 0 l 139 0 l 139 139 l 556 139 l 556 694 l 694 694 m 278 1111 l 417 1111 l 417 972 l 278 972 l 278 1111 m 139 972 l 278 972 l 278 833 l 139 833 l 139 972 m 417 972 l 556 972 l 556 833 l 417 833 l 417 972 z "},"ü":{"ha":833,"x_min":0,"x_max":694,"o":"m 0 139 l 0 694 l 139 694 l 139 139 l 0 139 m 694 694 l 694 0 l 139 0 l 139 139 l 556 139 l 556 694 l 694 694 m 139 972 l 278 972 l 278 833 l 139 833 l 139 972 m 417 972 l 556 972 l 556 833 l 417 833 l 417 972 z "},"ù":{"ha":833,"x_min":0,"x_max":694,"o":"m 0 139 l 0 694 l 139 694 l 139 139 l 0 139 m 694 694 l 694 0 l 139 0 l 139 139 l 556 139 l 556 694 l 694 694 m 139 1111 l 278 1111 l 278 972 l 139 972 l 139 1111 m 278 972 l 417 972 l 417 833 l 278 833 l 278 972 z "},"ű":{"ha":833,"x_min":0,"x_max":694,"o":"m 0 139 l 0 694 l 139 694 l 139 139 l 0 139 m 694 694 l 694 0 l 139 0 l 139 139 l 556 139 l 556 694 l 694 694 m 278 1111 l 417 1111 l 417 972 l 278 972 l 278 1111 m 556 1111 l 694 1111 l 694 972 l 556 972 l 556 1111 m 139 972 l 278 972 l 278 833 l 139 833 l 139 972 m 417 972 l 556 972 l 556 833 l 417 833 l 417 972 z "},"ū":{"ha":833,"x_min":0,"x_max":694,"o":"m 0 139 l 0 694 l 139 694 l 139 139 l 0 139 m 694 694 l 694 0 l 139 0 l 139 139 l 556 139 l 556 694 l 694 694 m 556 833 l 139 833 l 139 972 l 556 972 l 556 833 z "},"ų":{"ha":833,"x_min":0,"x_max":833,"o":"m 0 139 l 0 694 l 139 694 l 139 139 l 0 139 m 556 0 l 556 -139 l 417 -139 l 417 0 l 139 0 l 139 139 l 556 139 l 556 694 l 694 694 l 694 0 l 556 0 m 833 -278 l 556 -278 l 556 -139 l 833 -139 l 833 -278 z "},"ů":{"ha":833,"x_min":0,"x_max":694,"o":"m 0 139 l 0 694 l 139 694 l 139 139 l 0 139 m 694 694 l 694 0 l 139 0 l 139 139 l 556 139 l 556 694 l 694 694 m 278 1250 l 417 1250 l 417 1111 l 278 1111 l 278 1250 m 139 1111 l 278 1111 l 278 972 l 139 972 l 139 1111 m 417 1111 l 556 1111 l 556 972 l 417 972 l 417 1111 m 278 972 l 417 972 l 417 833 l 278 833 l 278 972 z "},"v":{"ha":833,"x_min":0,"x_max":694,"o":"m 139 417 l 0 417 l 0 694 l 139 694 l 139 417 m 694 694 l 694 417 l 556 417 l 556 694 l 694 694 m 278 139 l 139 139 l 139 417 l 278 417 l 278 139 m 556 417 l 556 139 l 417 139 l 417 417 l 556 417 m 278 139 l 417 139 l 417 0 l 278 0 l 278 139 z "},"w":{"ha":833,"x_min":0,"x_max":694,"o":"m 0 139 l 0 694 l 139 694 l 139 139 l 0 139 m 694 694 l 694 139 l 556 139 l 556 694 l 694 694 m 417 139 l 278 139 l 278 417 l 417 417 l 417 139 m 139 139 l 278 139 l 278 0 l 139 0 l 139 139 m 417 139 l 556 139 l 556 0 l 417 0 l 417 139 z "},"ẃ":{"ha":833,"x_min":0,"x_max":694,"o":"m 0 139 l 0 694 l 139 694 l 139 139 l 0 139 m 694 694 l 694 139 l 556 139 l 556 694 l 694 694 m 417 139 l 278 139 l 278 417 l 417 417 l 417 139 m 139 139 l 278 139 l 278 0 l 139 0 l 139 139 m 417 139 l 556 139 l 556 0 l 417 0 l 417 139 m 417 1111 l 556 1111 l 556 972 l 417 972 l 417 1111 m 278 972 l 417 972 l 417 833 l 278 833 l 278 972 z "},"ŵ":{"ha":833,"x_min":0,"x_max":694,"o":"m 0 139 l 0 694 l 139 694 l 139 139 l 0 139 m 694 694 l 694 139 l 556 139 l 556 694 l 694 694 m 417 139 l 278 139 l 278 417 l 417 417 l 417 139 m 139 139 l 278 139 l 278 0 l 139 0 l 139 139 m 417 139 l 556 139 l 556 0 l 417 0 l 417 139 m 278 1111 l 417 1111 l 417 972 l 278 972 l 278 1111 m 139 972 l 278 972 l 278 833 l 139 833 l 139 972 m 417 972 l 556 972 l 556 833 l 417 833 l 417 972 z "},"ẅ":{"ha":833,"x_min":0,"x_max":694,"o":"m 0 139 l 0 694 l 139 694 l 139 139 l 0 139 m 694 694 l 694 139 l 556 139 l 556 694 l 694 694 m 417 139 l 278 139 l 278 417 l 417 417 l 417 139 m 139 139 l 278 139 l 278 0 l 139 0 l 139 139 m 417 139 l 556 139 l 556 0 l 417 0 l 417 139 m 139 972 l 278 972 l 278 833 l 139 833 l 139 972 m 417 972 l 556 972 l 556 833 l 417 833 l 417 972 z "},"ẁ":{"ha":833,"x_min":0,"x_max":694,"o":"m 0 139 l 0 694 l 139 694 l 139 139 l 0 139 m 694 694 l 694 139 l 556 139 l 556 694 l 694 694 m 417 139 l 278 139 l 278 417 l 417 417 l 417 139 m 139 139 l 278 139 l 278 0 l 139 0 l 139 139 m 417 139 l 556 139 l 556 0 l 417 0 l 417 139 m 139 1111 l 278 1111 l 278 972 l 139 972 l 139 1111 m 278 972 l 417 972 l 417 833 l 278 833 l 278 972 z "},"x":{"ha":833,"x_min":0,"x_max":694,"o":"m 0 694 l 139 694 l 139 556 l 0 556 l 0 694 m 556 694 l 694 694 l 694 556 l 556 556 l 556 694 m 139 556 l 278 556 l 278 417 l 139 417 l 139 556 m 417 556 l 556 556 l 556 417 l 417 417 l 417 556 m 278 417 l 417 417 l 417 278 l 278 278 l 278 417 m 139 278 l 278 278 l 278 139 l 139 139 l 139 278 m 417 278 l 556 278 l 556 139 l 417 139 l 417 278 m 0 139 l 139 139 l 139 0 l 0 0 l 0 139 m 556 139 l 694 139 l 694 0 l 556 0 l 556 139 z "},"y":{"ha":833,"x_min":0,"x_max":694,"o":"m 0 139 l 0 694 l 139 694 l 139 139 l 0 139 m 694 694 l 694 -139 l 556 -139 l 556 0 l 139 0 l 139 139 l 556 139 l 556 694 l 694 694 m 556 -278 l 139 -278 l 139 -139 l 556 -139 l 556 -278 z "},"ý":{"ha":833,"x_min":0,"x_max":694,"o":"m 0 139 l 0 694 l 139 694 l 139 139 l 0 139 m 694 694 l 694 -139 l 556 -139 l 556 0 l 139 0 l 139 139 l 556 139 l 556 694 l 694 694 m 556 -278 l 139 -278 l 139 -139 l 556 -139 l 556 -278 m 417 1111 l 556 1111 l 556 972 l 417 972 l 417 1111 m 278 972 l 417 972 l 417 833 l 278 833 l 278 972 z "},"ŷ":{"ha":833,"x_min":0,"x_max":694,"o":"m 0 139 l 0 694 l 139 694 l 139 139 l 0 139 m 694 694 l 694 -139 l 556 -139 l 556 0 l 139 0 l 139 139 l 556 139 l 556 694 l 694 694 m 556 -278 l 139 -278 l 139 -139 l 556 -139 l 556 -278 m 278 1111 l 417 1111 l 417 972 l 278 972 l 278 1111 m 139 972 l 278 972 l 278 833 l 139 833 l 139 972 m 417 972 l 556 972 l 556 833 l 417 833 l 417 972 z "},"ÿ":{"ha":833,"x_min":0,"x_max":694,"o":"m 0 139 l 0 694 l 139 694 l 139 139 l 0 139 m 694 694 l 694 -139 l 556 -139 l 556 0 l 139 0 l 139 139 l 556 139 l 556 694 l 694 694 m 556 -278 l 139 -278 l 139 -139 l 556 -139 l 556 -278 m 139 972 l 278 972 l 278 833 l 139 833 l 139 972 m 417 972 l 556 972 l 556 833 l 417 833 l 417 972 z "},"ỳ":{"ha":833,"x_min":0,"x_max":694,"o":"m 0 139 l 0 694 l 139 694 l 139 139 l 0 139 m 694 694 l 694 -139 l 556 -139 l 556 0 l 139 0 l 139 139 l 556 139 l 556 694 l 694 694 m 556 -278 l 139 -278 l 139 -139 l 556 -139 l 556 -278 m 139 1111 l 278 1111 l 278 972 l 139 972 l 139 1111 m 278 972 l 417 972 l 417 833 l 278 833 l 278 972 z "},"z":{"ha":833,"x_min":0,"x_max":694,"o":"m 556 417 l 417 417 l 417 556 l 0 556 l 0 694 l 694 694 l 694 556 l 556 556 l 556 417 m 417 278 l 278 278 l 278 417 l 417 417 l 417 278 m 278 278 l 278 139 l 694 139 l 694 0 l 0 0 l 0 139 l 139 139 l 139 278 l 278 278 z "},"ź":{"ha":833,"x_min":0,"x_max":694,"o":"m 556 417 l 417 417 l 417 556 l 0 556 l 0 694 l 694 694 l 694 556 l 556 556 l 556 417 m 417 278 l 278 278 l 278 417 l 417 417 l 417 278 m 278 278 l 278 139 l 694 139 l 694 0 l 0 0 l 0 139 l 139 139 l 139 278 l 278 278 m 417 1111 l 556 1111 l 556 972 l 417 972 l 417 1111 m 278 972 l 417 972 l 417 833 l 278 833 l 278 972 z "},"ž":{"ha":833,"x_min":0,"x_max":694,"o":"m 556 417 l 417 417 l 417 556 l 0 556 l 0 694 l 694 694 l 694 556 l 556 556 l 556 417 m 417 278 l 278 278 l 278 417 l 417 417 l 417 278 m 278 278 l 278 139 l 694 139 l 694 0 l 0 0 l 0 139 l 139 139 l 139 278 l 278 278 m 139 1111 l 278 1111 l 278 972 l 139 972 l 139 1111 m 417 1111 l 556 1111 l 556 972 l 417 972 l 417 1111 m 278 972 l 417 972 l 417 833 l 278 833 l 278 972 z "},"ż":{"ha":833,"x_min":0,"x_max":694,"o":"m 556 417 l 417 417 l 417 556 l 0 556 l 0 694 l 694 694 l 694 556 l 556 556 l 556 417 m 417 278 l 278 278 l 278 417 l 417 417 l 417 278 m 278 278 l 278 139 l 694 139 l 694 0 l 0 0 l 0 139 l 139 139 l 139 278 l 278 278 m 278 972 l 417 972 l 417 833 l 278 833 l 278 972 z "},"ﬁ":{"ha":833,"x_min":0,"x_max":694,"o":"m 139 833 l 139 972 l 417 972 l 417 833 l 139 833 m 694 972 l 694 833 l 556 833 l 556 972 l 694 972 m 139 556 l 278 556 l 278 417 l 139 417 l 139 0 l 0 0 l 0 833 l 139 833 l 139 556 m 694 694 l 694 0 l 556 0 l 556 556 l 417 556 l 417 694 l 694 694 z "},"ﬂ":{"ha":833,"x_min":0,"x_max":694,"o":"m 417 139 l 417 833 l 139 833 l 139 972 l 556 972 l 556 139 l 417 139 m 139 833 l 139 556 l 278 556 l 278 417 l 139 417 l 139 0 l 0 0 l 0 833 l 139 833 m 694 139 l 694 0 l 556 0 l 556 139 l 694 139 z "},"ª":{"ha":833,"x_min":0,"x_max":556,"o":"m 556 556 l 139 556 l 139 694 l 417 694 l 417 972 l 139 972 l 139 1111 l 556 1111 l 556 556 m 139 694 l 0 694 l 0 972 l 139 972 l 139 694 z "},"º":{"ha":833,"x_min":0,"x_max":556,"o":"m 139 972 l 139 1111 l 417 1111 l 417 972 l 139 972 m 139 694 l 0 694 l 0 972 l 139 972 l 139 694 m 556 972 l 556 694 l 417 694 l 417 972 l 556 972 m 417 694 l 417 556 l 139 556 l 139 694 l 417 694 z "},"ⁿ":{"ha":833,"x_min":0,"x_max":556,"o":"m 417 972 l 139 972 l 139 556 l 0 556 l 0 1111 l 417 1111 l 417 972 m 556 972 l 556 556 l 417 556 l 417 972 l 556 972 z "},"Δ":{"ha":833,"x_min":0,"x_max":694,"o":"m 278 694 l 278 972 l 417 972 l 417 694 l 278 694 m 139 417 l 139 694 l 278 694 l 278 417 l 139 417 m 417 694 l 556 694 l 556 417 l 417 417 l 417 694 m 694 417 l 694 0 l 0 0 l 0 417 l 139 417 l 139 139 l 556 139 l 556 417 l 694 417 z "},"Ω":{"ha":833,"x_min":0,"x_max":694,"o":"m 556 833 l 139 833 l 139 972 l 556 972 l 556 833 m 139 833 l 139 278 l 0 278 l 0 833 l 139 833 m 694 833 l 694 278 l 556 278 l 556 833 l 694 833 m 139 139 l 139 278 l 278 278 l 278 0 l 0 0 l 0 139 l 139 139 m 556 278 l 556 139 l 694 139 l 694 0 l 417 0 l 417 278 l 556 278 z "},"μ":{"ha":833,"x_min":0,"x_max":694,"o":"m 556 0 l 139 0 l 139 -278 l 0 -278 l 0 694 l 139 694 l 139 139 l 556 139 l 556 0 m 694 694 l 694 139 l 556 139 l 556 694 l 694 694 z "},"π":{"ha":833,"x_min":0,"x_max":694,"o":"m 694 139 l 694 0 l 417 0 l 417 556 l 278 556 l 278 0 l 139 0 l 139 556 l 0 556 l 0 694 l 694 694 l 694 556 l 556 556 l 556 139 l 694 139 z "},"⁰":{"ha":833,"x_min":0,"x_max":556,"o":"m 139 1111 l 139 1250 l 417 1250 l 417 1111 l 139 1111 m 0 694 l 0 1111 l 139 1111 l 139 694 l 0 694 m 556 1111 l 556 694 l 417 694 l 417 1111 l 556 1111 m 417 694 l 417 556 l 139 556 l 139 694 l 417 694 z "},"¹":{"ha":833,"x_min":0,"x_max":417,"o":"m 417 694 l 417 556 l 0 556 l 0 694 l 139 694 l 139 972 l 0 972 l 0 1111 l 139 1111 l 139 1250 l 278 1250 l 278 694 l 417 694 z "},"²":{"ha":833,"x_min":0,"x_max":556,"o":"m 417 1111 l 139 1111 l 139 1250 l 417 1250 l 417 1111 m 0 1111 l 139 1111 l 139 972 l 0 972 l 0 1111 m 556 972 l 417 972 l 417 1111 l 556 1111 l 556 972 m 417 833 l 278 833 l 278 972 l 417 972 l 417 833 m 278 833 l 278 694 l 556 694 l 556 556 l 0 556 l 0 694 l 139 694 l 139 833 l 278 833 z "},"³":{"ha":833,"x_min":0,"x_max":556,"o":"m 417 1111 l 139 1111 l 139 1250 l 417 1250 l 417 1111 m 0 1111 l 139 1111 l 139 972 l 0 972 l 0 1111 m 556 972 l 417 972 l 417 1111 l 556 1111 l 556 972 m 417 972 l 417 833 l 278 833 l 278 972 l 417 972 m 139 833 l 139 694 l 0 694 l 0 833 l 139 833 m 417 694 l 417 833 l 556 833 l 556 694 l 417 694 m 417 694 l 417 556 l 139 556 l 139 694 l 417 694 z "},"⁴":{"ha":833,"x_min":0,"x_max":556,"o":"m 556 833 l 556 694 l 417 694 l 417 556 l 278 556 l 278 694 l 0 694 l 0 972 l 139 972 l 139 833 l 278 833 l 278 972 l 139 972 l 139 1111 l 278 1111 l 278 1250 l 417 1250 l 417 833 l 556 833 z "},"⁵":{"ha":833,"x_min":0,"x_max":556,"o":"m 139 972 l 556 972 l 556 694 l 417 694 l 417 833 l 0 833 l 0 1250 l 556 1250 l 556 1111 l 139 1111 l 139 972 m 417 556 l 0 556 l 0 694 l 417 694 l 417 556 z "},"⁶":{"ha":833,"x_min":0,"x_max":556,"o":"m 139 1111 l 139 1250 l 417 1250 l 417 1111 l 139 1111 m 139 694 l 0 694 l 0 1111 l 139 1111 l 139 972 l 417 972 l 417 833 l 139 833 l 139 694 m 556 833 l 556 694 l 417 694 l 417 833 l 556 833 m 417 694 l 417 556 l 139 556 l 139 694 l 417 694 z "},"⁷":{"ha":833,"x_min":0,"x_max":556,"o":"m 556 972 l 417 972 l 417 1111 l 0 1111 l 0 1250 l 556 1250 l 556 972 m 278 972 l 417 972 l 417 833 l 278 833 l 278 972 m 278 833 l 278 556 l 139 556 l 139 833 l 278 833 z "},"⁸":{"ha":833,"x_min":0,"x_max":556,"o":"m 139 1111 l 139 1250 l 417 1250 l 417 1111 l 139 1111 m 139 1111 l 139 972 l 0 972 l 0 1111 l 139 1111 m 417 972 l 417 1111 l 556 1111 l 556 972 l 417 972 m 417 833 l 139 833 l 139 972 l 417 972 l 417 833 m 139 833 l 139 694 l 0 694 l 0 833 l 139 833 m 417 694 l 417 833 l 556 833 l 556 694 l 417 694 m 417 694 l 417 556 l 139 556 l 139 694 l 417 694 z "},"⁹":{"ha":833,"x_min":0,"x_max":556,"o":"m 139 1111 l 139 1250 l 417 1250 l 417 1111 l 139 1111 m 139 1111 l 139 972 l 0 972 l 0 1111 l 139 1111 m 556 1111 l 556 694 l 417 694 l 417 833 l 139 833 l 139 972 l 417 972 l 417 1111 l 556 1111 m 417 694 l 417 556 l 139 556 l 139 694 l 417 694 z "},"⁄":{"ha":833,"x_min":0,"x_max":694,"o":"m 694 1111 l 694 833 l 556 833 l 556 1111 l 694 1111 m 556 833 l 556 556 l 417 556 l 417 833 l 556 833 m 417 556 l 417 278 l 278 278 l 278 556 l 417 556 m 278 278 l 278 0 l 139 0 l 139 278 l 278 278 m 139 0 l 139 -278 l 0 -278 l 0 0 l 139 0 z "},"½":{"ha":1667,"x_min":0,"x_max":1528,"o":"m 417 417 l 417 278 l 0 278 l 0 417 l 139 417 l 139 694 l 0 694 l 0 833 l 139 833 l 139 972 l 278 972 l 278 417 l 417 417 m 1111 1111 l 1111 833 l 972 833 l 972 1111 l 1111 1111 m 972 833 l 972 556 l 833 556 l 833 833 l 972 833 m 833 556 l 833 278 l 694 278 l 694 556 l 833 556 m 694 278 l 694 0 l 556 0 l 556 278 l 694 278 m 556 0 l 556 -278 l 417 -278 l 417 0 l 556 0 m 1389 417 l 1111 417 l 1111 556 l 1389 556 l 1389 417 m 972 417 l 1111 417 l 1111 278 l 972 278 l 972 417 m 1528 278 l 1389 278 l 1389 417 l 1528 417 l 1528 278 m 1389 139 l 1250 139 l 1250 278 l 1389 278 l 1389 139 m 1250 139 l 1250 0 l 1528 0 l 1528 -139 l 972 -139 l 972 0 l 1111 0 l 1111 139 l 1250 139 z "},"⅓":{"ha":1667,"x_min":0,"x_max":1528,"o":"m 417 417 l 417 278 l 0 278 l 0 417 l 139 417 l 139 694 l 0 694 l 0 833 l 139 833 l 139 972 l 278 972 l 278 417 l 417 417 m 1111 1111 l 1111 833 l 972 833 l 972 1111 l 1111 1111 m 972 833 l 972 556 l 833 556 l 833 833 l 972 833 m 833 556 l 833 278 l 694 278 l 694 556 l 833 556 m 694 278 l 694 0 l 556 0 l 556 278 l 694 278 m 556 0 l 556 -278 l 417 -278 l 417 0 l 556 0 m 1389 278 l 1111 278 l 1111 417 l 1389 417 l 1389 278 m 972 278 l 1111 278 l 1111 139 l 972 139 l 972 278 m 1528 139 l 1389 139 l 1389 278 l 1528 278 l 1528 139 m 1389 139 l 1389 0 l 1250 0 l 1250 139 l 1389 139 m 1111 0 l 1111 -139 l 972 -139 l 972 0 l 1111 0 m 1389 -139 l 1389 0 l 1528 0 l 1528 -139 l 1389 -139 m 1389 -139 l 1389 -278 l 1111 -278 l 1111 -139 l 1389 -139 z "},"⅔":{"ha":1667,"x_min":0,"x_max":1528,"o":"m 972 833 l 972 1111 l 1111 1111 l 1111 833 l 972 833 m 417 833 l 139 833 l 139 972 l 417 972 l 417 833 m 0 833 l 139 833 l 139 694 l 0 694 l 0 833 m 556 694 l 417 694 l 417 833 l 556 833 l 556 694 m 833 556 l 833 833 l 972 833 l 972 556 l 833 556 m 417 556 l 278 556 l 278 694 l 417 694 l 417 556 m 556 278 l 0 278 l 0 417 l 139 417 l 139 556 l 278 556 l 278 417 l 556 417 l 556 278 m 833 556 l 833 278 l 694 278 l 694 556 l 833 556 m 1389 278 l 1111 278 l 1111 417 l 1389 417 l 1389 278 m 694 278 l 694 0 l 556 0 l 556 278 l 694 278 m 972 278 l 1111 278 l 1111 139 l 972 139 l 972 278 m 1528 139 l 1389 139 l 1389 278 l 1528 278 l 1528 139 m 1389 139 l 1389 0 l 1250 0 l 1250 139 l 1389 139 m 556 0 l 556 -278 l 417 -278 l 417 0 l 556 0 m 1111 0 l 1111 -139 l 972 -139 l 972 0 l 1111 0 m 1389 -139 l 1389 0 l 1528 0 l 1528 -139 l 1389 -139 m 1389 -139 l 1389 -278 l 1111 -278 l 1111 -139 l 1389 -139 z "},"¼":{"ha":1667,"x_min":0,"x_max":1528,"o":"m 417 417 l 417 278 l 0 278 l 0 417 l 139 417 l 139 694 l 0 694 l 0 833 l 139 833 l 139 972 l 278 972 l 278 417 l 417 417 m 1111 1111 l 1111 833 l 972 833 l 972 1111 l 1111 1111 m 972 833 l 972 556 l 833 556 l 833 833 l 972 833 m 833 556 l 833 278 l 694 278 l 694 556 l 833 556 m 694 278 l 694 0 l 556 0 l 556 278 l 694 278 m 556 0 l 556 -278 l 417 -278 l 417 0 l 556 0 m 1528 139 l 1528 0 l 1389 0 l 1389 -139 l 1250 -139 l 1250 0 l 972 0 l 972 278 l 1111 278 l 1111 139 l 1250 139 l 1250 278 l 1111 278 l 1111 417 l 1250 417 l 1250 556 l 1389 556 l 1389 139 l 1528 139 z "},"¾":{"ha":1667,"x_min":0,"x_max":1528,"o":"m 1111 1111 l 1111 833 l 972 833 l 972 1111 l 1111 1111 m 972 833 l 972 556 l 833 556 l 833 833 l 972 833 m 833 556 l 833 278 l 694 278 l 694 556 l 833 556 m 694 278 l 694 0 l 556 0 l 556 278 l 694 278 m 556 0 l 556 -278 l 417 -278 l 417 0 l 556 0 m 1528 139 l 1528 0 l 1389 0 l 1389 -139 l 1250 -139 l 1250 0 l 972 0 l 972 278 l 1111 278 l 1111 139 l 1250 139 l 1250 278 l 1111 278 l 1111 417 l 1250 417 l 1250 556 l 1389 556 l 1389 139 l 1528 139 m 417 833 l 139 833 l 139 972 l 417 972 l 417 833 m 0 833 l 139 833 l 139 694 l 0 694 l 0 833 m 556 694 l 417 694 l 417 833 l 556 833 l 556 694 m 417 694 l 417 556 l 278 556 l 278 694 l 417 694 m 139 556 l 139 417 l 0 417 l 0 556 l 139 556 m 417 417 l 417 556 l 556 556 l 556 417 l 417 417 m 417 417 l 417 278 l 139 278 l 139 417 l 417 417 z "},"⅕":{"ha":1667,"x_min":0,"x_max":1528,"o":"m 972 833 l 972 1111 l 1111 1111 l 1111 833 l 972 833 m 417 278 l 0 278 l 0 417 l 139 417 l 139 694 l 0 694 l 0 833 l 139 833 l 139 972 l 278 972 l 278 417 l 417 417 l 417 278 m 972 556 l 833 556 l 833 833 l 972 833 l 972 556 m 833 556 l 833 278 l 694 278 l 694 556 l 833 556 m 1111 278 l 1528 278 l 1528 0 l 1389 0 l 1389 139 l 972 139 l 972 556 l 1528 556 l 1528 417 l 1111 417 l 1111 278 m 694 278 l 694 0 l 556 0 l 556 278 l 694 278 m 556 0 l 556 -278 l 417 -278 l 417 0 l 556 0 m 1389 -139 l 972 -139 l 972 0 l 1389 0 l 1389 -139 z "},"⅖":{"ha":1667,"x_min":0,"x_max":1528,"o":"m 972 833 l 972 1111 l 1111 1111 l 1111 833 l 972 833 m 417 833 l 139 833 l 139 972 l 417 972 l 417 833 m 0 833 l 139 833 l 139 694 l 0 694 l 0 833 m 556 694 l 417 694 l 417 833 l 556 833 l 556 694 m 972 556 l 833 556 l 833 833 l 972 833 l 972 556 m 417 556 l 278 556 l 278 694 l 417 694 l 417 556 m 556 278 l 0 278 l 0 417 l 139 417 l 139 556 l 278 556 l 278 417 l 556 417 l 556 278 m 833 556 l 833 278 l 694 278 l 694 556 l 833 556 m 1111 278 l 1528 278 l 1528 0 l 1389 0 l 1389 139 l 972 139 l 972 556 l 1528 556 l 1528 417 l 1111 417 l 1111 278 m 694 278 l 694 0 l 556 0 l 556 278 l 694 278 m 556 0 l 556 -278 l 417 -278 l 417 0 l 556 0 m 1389 -139 l 972 -139 l 972 0 l 1389 0 l 1389 -139 z "},"⅗":{"ha":1667,"x_min":0,"x_max":1528,"o":"m 972 833 l 972 1111 l 1111 1111 l 1111 833 l 972 833 m 417 833 l 139 833 l 139 972 l 417 972 l 417 833 m 0 833 l 139 833 l 139 694 l 0 694 l 0 833 m 556 694 l 417 694 l 417 833 l 556 833 l 556 694 m 972 556 l 833 556 l 833 833 l 972 833 l 972 556 m 417 694 l 417 556 l 278 556 l 278 694 l 417 694 m 139 556 l 139 417 l 0 417 l 0 556 l 139 556 m 556 417 l 417 417 l 417 556 l 556 556 l 556 417 m 833 556 l 833 278 l 694 278 l 694 556 l 833 556 m 1111 278 l 1528 278 l 1528 0 l 1389 0 l 1389 139 l 972 139 l 972 556 l 1528 556 l 1528 417 l 1111 417 l 1111 278 m 417 278 l 139 278 l 139 417 l 417 417 l 417 278 m 694 278 l 694 0 l 556 0 l 556 278 l 694 278 m 556 0 l 556 -278 l 417 -278 l 417 0 l 556 0 m 1389 -139 l 972 -139 l 972 0 l 1389 0 l 1389 -139 z "},"⅘":{"ha":1667,"x_min":0,"x_max":1528,"o":"m 972 833 l 972 1111 l 1111 1111 l 1111 833 l 972 833 m 278 278 l 278 417 l 0 417 l 0 694 l 139 694 l 139 556 l 278 556 l 278 694 l 139 694 l 139 833 l 278 833 l 278 972 l 417 972 l 417 556 l 556 556 l 556 417 l 417 417 l 417 278 l 278 278 m 972 556 l 833 556 l 833 833 l 972 833 l 972 556 m 833 556 l 833 278 l 694 278 l 694 556 l 833 556 m 1111 278 l 1528 278 l 1528 0 l 1389 0 l 1389 139 l 972 139 l 972 556 l 1528 556 l 1528 417 l 1111 417 l 1111 278 m 694 278 l 694 0 l 556 0 l 556 278 l 694 278 m 556 0 l 556 -278 l 417 -278 l 417 0 l 556 0 m 1389 -139 l 972 -139 l 972 0 l 1389 0 l 1389 -139 z "},"⅙":{"ha":1667,"x_min":0,"x_max":1528,"o":"m 417 417 l 417 278 l 0 278 l 0 417 l 139 417 l 139 694 l 0 694 l 0 833 l 139 833 l 139 972 l 278 972 l 278 417 l 417 417 m 1111 1111 l 1111 833 l 972 833 l 972 1111 l 1111 1111 m 972 833 l 972 556 l 833 556 l 833 833 l 972 833 m 833 556 l 833 278 l 694 278 l 694 556 l 833 556 m 694 278 l 694 0 l 556 0 l 556 278 l 694 278 m 556 0 l 556 -278 l 417 -278 l 417 0 l 556 0 m 1111 417 l 1111 556 l 1389 556 l 1389 417 l 1111 417 m 1111 0 l 972 0 l 972 417 l 1111 417 l 1111 278 l 1389 278 l 1389 139 l 1111 139 l 1111 0 m 1528 139 l 1528 0 l 1389 0 l 1389 139 l 1528 139 m 1389 0 l 1389 -139 l 1111 -139 l 1111 0 l 1389 0 z "},"⅚":{"ha":1667,"x_min":0,"x_max":1528,"o":"m 1111 1111 l 1111 833 l 972 833 l 972 1111 l 1111 1111 m 972 833 l 972 556 l 833 556 l 833 833 l 972 833 m 833 556 l 833 278 l 694 278 l 694 556 l 833 556 m 694 278 l 694 0 l 556 0 l 556 278 l 694 278 m 556 0 l 556 -278 l 417 -278 l 417 0 l 556 0 m 1111 417 l 1111 556 l 1389 556 l 1389 417 l 1111 417 m 1111 0 l 972 0 l 972 417 l 1111 417 l 1111 278 l 1389 278 l 1389 139 l 1111 139 l 1111 0 m 1528 139 l 1528 0 l 1389 0 l 1389 139 l 1528 139 m 1389 0 l 1389 -139 l 1111 -139 l 1111 0 l 1389 0 m 139 694 l 556 694 l 556 417 l 417 417 l 417 556 l 0 556 l 0 972 l 556 972 l 556 833 l 139 833 l 139 694 m 417 278 l 0 278 l 0 417 l 417 417 l 417 278 z "},"⅐":{"ha":1667,"x_min":0,"x_max":1528,"o":"m 972 833 l 972 1111 l 1111 1111 l 1111 833 l 972 833 m 417 278 l 0 278 l 0 417 l 139 417 l 139 694 l 0 694 l 0 833 l 139 833 l 139 972 l 278 972 l 278 417 l 417 417 l 417 278 m 972 556 l 833 556 l 833 833 l 972 833 l 972 556 m 833 556 l 833 278 l 694 278 l 694 556 l 833 556 m 1528 278 l 1389 278 l 1389 417 l 972 417 l 972 556 l 1528 556 l 1528 278 m 694 278 l 694 0 l 556 0 l 556 278 l 694 278 m 1250 278 l 1389 278 l 1389 139 l 1250 139 l 1250 278 m 1250 139 l 1250 -139 l 1111 -139 l 1111 139 l 1250 139 m 556 0 l 556 -278 l 417 -278 l 417 0 l 556 0 z "},"⅛":{"ha":1667,"x_min":0,"x_max":1528,"o":"m 417 417 l 417 278 l 0 278 l 0 417 l 139 417 l 139 694 l 0 694 l 0 833 l 139 833 l 139 972 l 278 972 l 278 417 l 417 417 m 1111 1111 l 1111 833 l 972 833 l 972 1111 l 1111 1111 m 972 833 l 972 556 l 833 556 l 833 833 l 972 833 m 833 556 l 833 278 l 694 278 l 694 556 l 833 556 m 694 278 l 694 0 l 556 0 l 556 278 l 694 278 m 556 0 l 556 -278 l 417 -278 l 417 0 l 556 0 m 1111 417 l 1111 556 l 1389 556 l 1389 417 l 1111 417 m 1111 417 l 1111 278 l 972 278 l 972 417 l 1111 417 m 1389 278 l 1389 417 l 1528 417 l 1528 278 l 1389 278 m 1389 139 l 1111 139 l 1111 278 l 1389 278 l 1389 139 m 1111 139 l 1111 0 l 972 0 l 972 139 l 1111 139 m 1389 0 l 1389 139 l 1528 139 l 1528 0 l 1389 0 m 1389 0 l 1389 -139 l 1111 -139 l 1111 0 l 1389 0 z "},"⅜":{"ha":1667,"x_min":0,"x_max":1528,"o":"m 1111 1111 l 1111 833 l 972 833 l 972 1111 l 1111 1111 m 972 833 l 972 556 l 833 556 l 833 833 l 972 833 m 833 556 l 833 278 l 694 278 l 694 556 l 833 556 m 694 278 l 694 0 l 556 0 l 556 278 l 694 278 m 556 0 l 556 -278 l 417 -278 l 417 0 l 556 0 m 1111 417 l 1111 556 l 1389 556 l 1389 417 l 1111 417 m 1111 417 l 1111 278 l 972 278 l 972 417 l 1111 417 m 1389 278 l 1389 417 l 1528 417 l 1528 278 l 1389 278 m 1389 139 l 1111 139 l 1111 278 l 1389 278 l 1389 139 m 1111 139 l 1111 0 l 972 0 l 972 139 l 1111 139 m 1389 0 l 1389 139 l 1528 139 l 1528 0 l 1389 0 m 1389 0 l 1389 -139 l 1111 -139 l 1111 0 l 1389 0 m 417 833 l 139 833 l 139 972 l 417 972 l 417 833 m 0 833 l 139 833 l 139 694 l 0 694 l 0 833 m 556 694 l 417 694 l 417 833 l 556 833 l 556 694 m 417 694 l 417 556 l 278 556 l 278 694 l 417 694 m 139 556 l 139 417 l 0 417 l 0 556 l 139 556 m 417 417 l 417 556 l 556 556 l 556 417 l 417 417 m 417 417 l 417 278 l 139 278 l 139 417 l 417 417 z "},"⅝":{"ha":1667,"x_min":0,"x_max":1528,"o":"m 1111 1111 l 1111 833 l 972 833 l 972 1111 l 1111 1111 m 972 833 l 972 556 l 833 556 l 833 833 l 972 833 m 833 556 l 833 278 l 694 278 l 694 556 l 833 556 m 694 278 l 694 0 l 556 0 l 556 278 l 694 278 m 556 0 l 556 -278 l 417 -278 l 417 0 l 556 0 m 1111 417 l 1111 556 l 1389 556 l 1389 417 l 1111 417 m 1111 417 l 1111 278 l 972 278 l 972 417 l 1111 417 m 1389 278 l 1389 417 l 1528 417 l 1528 278 l 1389 278 m 1389 139 l 1111 139 l 1111 278 l 1389 278 l 1389 139 m 1111 139 l 1111 0 l 972 0 l 972 139 l 1111 139 m 1389 0 l 1389 139 l 1528 139 l 1528 0 l 1389 0 m 1389 0 l 1389 -139 l 1111 -139 l 1111 0 l 1389 0 m 139 694 l 556 694 l 556 417 l 417 417 l 417 556 l 0 556 l 0 972 l 556 972 l 556 833 l 139 833 l 139 694 m 417 278 l 0 278 l 0 417 l 417 417 l 417 278 z "},"⅞":{"ha":1667,"x_min":0,"x_max":1528,"o":"m 1111 1111 l 1111 833 l 972 833 l 972 1111 l 1111 1111 m 972 833 l 972 556 l 833 556 l 833 833 l 972 833 m 833 556 l 833 278 l 694 278 l 694 556 l 833 556 m 694 278 l 694 0 l 556 0 l 556 278 l 694 278 m 556 0 l 556 -278 l 417 -278 l 417 0 l 556 0 m 1111 417 l 1111 556 l 1389 556 l 1389 417 l 1111 417 m 1111 417 l 1111 278 l 972 278 l 972 417 l 1111 417 m 1389 278 l 1389 417 l 1528 417 l 1528 278 l 1389 278 m 1389 139 l 1111 139 l 1111 278 l 1389 278 l 1389 139 m 1111 139 l 1111 0 l 972 0 l 972 139 l 1111 139 m 1389 0 l 1389 139 l 1528 139 l 1528 0 l 1389 0 m 1389 0 l 1389 -139 l 1111 -139 l 1111 0 l 1389 0 m 556 694 l 417 694 l 417 833 l 0 833 l 0 972 l 556 972 l 556 694 m 278 694 l 417 694 l 417 556 l 278 556 l 278 694 m 278 556 l 278 278 l 139 278 l 139 556 l 278 556 z "},"⅑":{"ha":1667,"x_min":0,"x_max":1528,"o":"m 417 417 l 417 278 l 0 278 l 0 417 l 139 417 l 139 694 l 0 694 l 0 833 l 139 833 l 139 972 l 278 972 l 278 417 l 417 417 m 1111 1111 l 1111 833 l 972 833 l 972 1111 l 1111 1111 m 972 833 l 972 556 l 833 556 l 833 833 l 972 833 m 833 556 l 833 278 l 694 278 l 694 556 l 833 556 m 694 278 l 694 0 l 556 0 l 556 278 l 694 278 m 556 0 l 556 -278 l 417 -278 l 417 0 l 556 0 m 1111 417 l 1111 556 l 1389 556 l 1389 417 l 1111 417 m 1111 417 l 1111 278 l 972 278 l 972 417 l 1111 417 m 1528 417 l 1528 0 l 1389 0 l 1389 139 l 1111 139 l 1111 278 l 1389 278 l 1389 417 l 1528 417 m 1389 0 l 1389 -139 l 1111 -139 l 1111 0 l 1389 0 z "},".":{"ha":833,"x_min":139,"x_max":417,"o":"m 417 0 l 139 0 l 139 278 l 417 278 l 417 0 z "},",":{"ha":833,"x_min":139,"x_max":417,"o":"m 417 -139 l 278 -139 l 278 0 l 139 0 l 139 278 l 417 278 l 417 -139 m 139 -139 l 278 -139 l 278 -278 l 139 -278 l 139 -139 z "},":":{"ha":833,"x_min":139,"x_max":417,"o":"m 417 0 l 139 0 l 139 278 l 417 278 l 417 0 m 417 417 l 139 417 l 139 694 l 417 694 l 417 417 z "},";":{"ha":833,"x_min":139,"x_max":417,"o":"m 417 417 l 139 417 l 139 694 l 417 694 l 417 417 m 417 -139 l 278 -139 l 278 0 l 139 0 l 139 278 l 417 278 l 417 -139 m 139 -139 l 278 -139 l 278 -278 l 139 -278 l 139 -139 z "},"…":{"ha":833,"x_min":0,"x_max":694,"o":"m 0 139 l 139 139 l 139 0 l 0 0 l 0 139 m 278 139 l 417 139 l 417 0 l 278 0 l 278 139 m 556 139 l 694 139 l 694 0 l 556 0 l 556 139 z "},"!":{"ha":833,"x_min":278,"x_max":417,"o":"m 417 972 l 417 278 l 278 278 l 278 972 l 417 972 m 278 139 l 417 139 l 417 0 l 278 0 l 278 139 z "},"¡":{"ha":833,"x_min":278,"x_max":417,"o":"m 417 972 l 417 833 l 278 833 l 278 972 l 417 972 m 417 694 l 417 0 l 278 0 l 278 694 l 417 694 z "},"?":{"ha":833,"x_min":0,"x_max":694,"o":"m 556 833 l 139 833 l 139 972 l 556 972 l 556 833 m 0 833 l 139 833 l 139 694 l 0 694 l 0 833 m 694 833 l 694 556 l 556 556 l 556 833 l 694 833 m 417 556 l 556 556 l 556 417 l 417 417 l 417 556 m 278 417 l 417 417 l 417 278 l 278 278 l 278 417 m 278 139 l 417 139 l 417 0 l 278 0 l 278 139 z "},"¿":{"ha":833,"x_min":0,"x_max":694,"o":"m 417 833 l 278 833 l 278 972 l 417 972 l 417 833 m 417 556 l 278 556 l 278 694 l 417 694 l 417 556 m 278 417 l 139 417 l 139 556 l 278 556 l 278 417 m 139 139 l 0 139 l 0 417 l 139 417 l 139 139 m 694 278 l 694 139 l 556 139 l 556 278 l 694 278 m 556 0 l 139 0 l 139 139 l 556 139 l 556 0 z "},"·":{"ha":833,"x_min":139,"x_max":417,"o":"m 417 417 l 139 417 l 139 694 l 417 694 l 417 417 z "},"•":{"ha":833,"x_min":139,"x_max":417,"o":"m 417 417 l 139 417 l 139 694 l 417 694 l 417 417 z "},"*":{"ha":833,"x_min":0,"x_max":694,"o":"m 556 556 l 556 417 l 417 417 l 417 139 l 278 139 l 278 417 l 139 417 l 139 556 l 278 556 l 278 833 l 417 833 l 417 556 l 556 556 m 139 694 l 139 556 l 0 556 l 0 694 l 139 694 m 694 556 l 556 556 l 556 694 l 694 694 l 694 556 m 0 417 l 139 417 l 139 278 l 0 278 l 0 417 m 556 278 l 556 417 l 694 417 l 694 278 l 556 278 z "},"#":{"ha":833,"x_min":0,"x_max":694,"o":"m 556 556 l 556 417 l 694 417 l 694 278 l 556 278 l 556 139 l 417 139 l 417 278 l 278 278 l 278 139 l 139 139 l 139 278 l 0 278 l 0 417 l 139 417 l 139 556 l 0 556 l 0 694 l 139 694 l 139 833 l 278 833 l 278 694 l 417 694 l 417 833 l 556 833 l 556 694 l 694 694 l 694 556 l 556 556 m 417 556 l 278 556 l 278 417 l 417 417 l 417 556 z "},"/":{"ha":833,"x_min":0,"x_max":694,"o":"m 694 1111 l 694 833 l 556 833 l 556 1111 l 694 1111 m 556 833 l 556 556 l 417 556 l 417 833 l 556 833 m 417 556 l 417 278 l 278 278 l 278 556 l 417 556 m 278 278 l 278 0 l 139 0 l 139 278 l 278 278 m 139 0 l 139 -278 l 0 -278 l 0 0 l 139 0 z "},"\\":{"ha":833,"x_min":0,"x_max":694,"o":"m 139 833 l 0 833 l 0 1111 l 139 1111 l 139 833 m 278 556 l 139 556 l 139 833 l 278 833 l 278 556 m 417 278 l 278 278 l 278 556 l 417 556 l 417 278 m 556 0 l 417 0 l 417 278 l 556 278 l 556 0 m 694 0 l 694 -278 l 556 -278 l 556 0 l 694 0 z "},"(":{"ha":833,"x_min":139,"x_max":556,"o":"m 556 972 l 417 972 l 417 1111 l 556 1111 l 556 972 m 278 694 l 278 972 l 417 972 l 417 694 l 278 694 m 139 278 l 139 694 l 278 694 l 278 278 l 139 278 m 278 278 l 417 278 l 417 0 l 278 0 l 278 278 m 417 -139 l 417 0 l 556 0 l 556 -139 l 417 -139 z "},")":{"ha":833,"x_min":139,"x_max":556,"o":"m 278 1111 l 278 972 l 139 972 l 139 1111 l 278 1111 m 417 694 l 278 694 l 278 972 l 417 972 l 417 694 m 556 694 l 556 278 l 417 278 l 417 694 l 556 694 m 417 278 l 417 0 l 278 0 l 278 278 l 417 278 m 139 0 l 278 0 l 278 -139 l 139 -139 l 139 0 z "},"{":{"ha":833,"x_min":139,"x_max":556,"o":"m 556 972 l 417 972 l 417 1111 l 556 1111 l 556 972 m 278 556 l 278 972 l 417 972 l 417 556 l 278 556 m 278 556 l 278 417 l 139 417 l 139 556 l 278 556 m 417 417 l 417 0 l 278 0 l 278 417 l 417 417 m 417 -139 l 417 0 l 556 0 l 556 -139 l 417 -139 z "},"}":{"ha":833,"x_min":139,"x_max":556,"o":"m 278 1111 l 278 972 l 139 972 l 139 1111 l 278 1111 m 278 556 l 278 972 l 417 972 l 417 556 l 278 556 m 556 556 l 556 417 l 417 417 l 417 556 l 556 556 m 417 417 l 417 0 l 278 0 l 278 417 l 417 417 m 139 0 l 278 0 l 278 -139 l 139 -139 l 139 0 z "},"[":{"ha":833,"x_min":278,"x_max":556,"o":"m 556 0 l 556 -139 l 278 -139 l 278 1111 l 556 1111 l 556 972 l 417 972 l 417 0 l 556 0 z "},"]":{"ha":833,"x_min":139,"x_max":417,"o":"m 417 -139 l 139 -139 l 139 0 l 278 0 l 278 972 l 139 972 l 139 1111 l 417 1111 l 417 -139 z "},"-":{"ha":833,"x_min":139,"x_max":556,"o":"m 556 417 l 139 417 l 139 556 l 556 556 l 556 417 z "},"­":{"ha":833,"x_min":0,"x_max":0,"o":""},"–":{"ha":833,"x_min":0,"x_max":694,"o":"m 694 417 l 0 417 l 0 556 l 694 556 l 694 417 z "},"—":{"ha":833,"x_min":-139,"x_max":833,"o":"m 833 417 l -139 417 l -139 556 l 833 556 l 833 417 z "},"_":{"ha":833,"x_min":0,"x_max":694,"o":"m 694 0 l 0 0 l 0 139 l 694 139 l 694 0 z "},"‚":{"ha":833,"x_min":278,"x_max":556,"o":"m 556 -139 l 417 -139 l 417 0 l 278 0 l 278 278 l 556 278 l 556 -139 m 278 -139 l 417 -139 l 417 -278 l 278 -278 l 278 -139 z "},"„":{"ha":833,"x_min":0,"x_max":694,"o":"m 278 -139 l 139 -139 l 139 0 l 0 0 l 0 278 l 278 278 l 278 -139 m 0 -139 l 139 -139 l 139 -278 l 0 -278 l 0 -139 m 694 -139 l 556 -139 l 556 0 l 417 0 l 417 278 l 694 278 l 694 -139 m 417 -139 l 556 -139 l 556 -278 l 417 -278 l 417 -139 z "},"“":{"ha":833,"x_min":0,"x_max":694,"o":"m 278 972 l 139 972 l 139 1111 l 278 1111 l 278 972 m 139 972 l 139 833 l 278 833 l 278 556 l 0 556 l 0 972 l 139 972 m 694 972 l 556 972 l 556 1111 l 694 1111 l 694 972 m 556 972 l 556 833 l 694 833 l 694 556 l 417 556 l 417 972 l 556 972 z "},"”":{"ha":833,"x_min":0,"x_max":694,"o":"m 278 694 l 139 694 l 139 833 l 0 833 l 0 1111 l 278 1111 l 278 694 m 0 694 l 139 694 l 139 556 l 0 556 l 0 694 m 694 694 l 556 694 l 556 833 l 417 833 l 417 1111 l 694 1111 l 694 694 m 417 694 l 556 694 l 556 556 l 417 556 l 417 694 z "},"‘":{"ha":833,"x_min":278,"x_max":556,"o":"m 556 972 l 417 972 l 417 1111 l 556 1111 l 556 972 m 417 972 l 417 833 l 556 833 l 556 556 l 278 556 l 278 972 l 417 972 z "},"’":{"ha":833,"x_min":139,"x_max":417,"o":"m 417 694 l 278 694 l 278 833 l 139 833 l 139 1111 l 417 1111 l 417 694 m 139 694 l 278 694 l 278 556 l 139 556 l 139 694 z "},"«":{"ha":833,"x_min":0,"x_max":694,"o":"m 278 833 l 417 833 l 417 694 l 278 694 l 278 833 m 556 833 l 694 833 l 694 694 l 556 694 l 556 833 m 139 694 l 278 694 l 278 556 l 139 556 l 139 694 m 417 694 l 556 694 l 556 556 l 417 556 l 417 694 m 0 556 l 139 556 l 139 417 l 0 417 l 0 556 m 278 556 l 417 556 l 417 417 l 278 417 l 278 556 m 139 417 l 278 417 l 278 278 l 139 278 l 139 417 m 417 417 l 556 417 l 556 278 l 417 278 l 417 417 m 278 278 l 417 278 l 417 139 l 278 139 l 278 278 m 556 278 l 694 278 l 694 139 l 556 139 l 556 278 z "},"»":{"ha":833,"x_min":0,"x_max":694,"o":"m 0 833 l 139 833 l 139 694 l 0 694 l 0 833 m 278 833 l 417 833 l 417 694 l 278 694 l 278 833 m 139 694 l 278 694 l 278 556 l 139 556 l 139 694 m 417 694 l 556 694 l 556 556 l 417 556 l 417 694 m 278 556 l 417 556 l 417 417 l 278 417 l 278 556 m 556 556 l 694 556 l 694 417 l 556 417 l 556 556 m 139 417 l 278 417 l 278 278 l 139 278 l 139 417 m 417 417 l 556 417 l 556 278 l 417 278 l 417 417 m 0 278 l 139 278 l 139 139 l 0 139 l 0 278 m 278 278 l 417 278 l 417 139 l 278 139 l 278 278 z "},"‹":{"ha":833,"x_min":139,"x_max":556,"o":"m 417 833 l 556 833 l 556 694 l 417 694 l 417 833 m 278 694 l 417 694 l 417 556 l 278 556 l 278 694 m 139 556 l 278 556 l 278 417 l 139 417 l 139 556 m 278 417 l 417 417 l 417 278 l 278 278 l 278 417 m 417 278 l 556 278 l 556 139 l 417 139 l 417 278 z "},"›":{"ha":833,"x_min":139,"x_max":556,"o":"m 139 833 l 278 833 l 278 694 l 139 694 l 139 833 m 278 694 l 417 694 l 417 556 l 278 556 l 278 694 m 417 556 l 556 556 l 556 417 l 417 417 l 417 556 m 278 417 l 417 417 l 417 278 l 278 278 l 278 417 m 139 278 l 278 278 l 278 139 l 139 139 l 139 278 z "},"\"":{"ha":833,"x_min":139,"x_max":556,"o":"m 278 1111 l 278 694 l 139 694 l 139 1111 l 278 1111 m 556 1111 l 556 694 l 417 694 l 417 1111 l 556 1111 z "},"'":{"ha":833,"x_min":278,"x_max":417,"o":"m 417 1111 l 417 694 l 278 694 l 278 1111 l 417 1111 z "}," ":{"ha":833,"x_min":0,"x_max":0,"o":""},"¢":{"ha":833,"x_min":0,"x_max":694,"o":"m 556 833 l 556 694 l 417 694 l 417 278 l 556 278 l 556 139 l 417 139 l 417 0 l 278 0 l 278 139 l 139 139 l 139 278 l 278 278 l 278 694 l 139 694 l 139 833 l 278 833 l 278 972 l 417 972 l 417 833 l 556 833 m 0 278 l 0 694 l 139 694 l 139 278 l 0 278 m 556 556 l 556 694 l 694 694 l 694 556 l 556 556 m 694 278 l 556 278 l 556 417 l 694 417 l 694 278 z "},"¤":{"ha":833,"x_min":0,"x_max":694,"o":"m 139 833 l 139 694 l 0 694 l 0 833 l 139 833 m 694 694 l 556 694 l 556 833 l 694 833 l 694 694 m 139 278 l 139 694 l 556 694 l 556 278 l 139 278 m 417 417 l 417 556 l 278 556 l 278 417 l 417 417 m 0 278 l 139 278 l 139 139 l 0 139 l 0 278 m 556 139 l 556 278 l 694 278 l 694 139 l 556 139 z "},"$":{"ha":833,"x_min":0,"x_max":694,"o":"m 556 972 l 556 833 l 417 833 l 417 556 l 556 556 l 556 417 l 417 417 l 417 139 l 556 139 l 556 0 l 417 0 l 417 -139 l 278 -139 l 278 0 l 139 0 l 139 139 l 278 139 l 278 417 l 139 417 l 139 556 l 278 556 l 278 833 l 139 833 l 139 972 l 278 972 l 278 1111 l 417 1111 l 417 972 l 556 972 m 139 556 l 0 556 l 0 833 l 139 833 l 139 556 m 556 694 l 556 833 l 694 833 l 694 694 l 556 694 m 556 417 l 694 417 l 694 139 l 556 139 l 556 417 m 139 278 l 139 139 l 0 139 l 0 278 l 139 278 z "},"€":{"ha":833,"x_min":0,"x_max":694,"o":"m 556 833 l 278 833 l 278 972 l 556 972 l 556 833 m 139 833 l 278 833 l 278 694 l 417 694 l 417 556 l 278 556 l 278 417 l 417 417 l 417 278 l 278 278 l 278 139 l 139 139 l 139 278 l 0 278 l 0 417 l 139 417 l 139 556 l 0 556 l 0 694 l 139 694 l 139 833 m 556 694 l 556 833 l 694 833 l 694 694 l 556 694 m 694 139 l 556 139 l 556 278 l 694 278 l 694 139 m 278 139 l 556 139 l 556 0 l 278 0 l 278 139 z "},"ƒ":{"ha":833,"x_min":0,"x_max":694,"o":"m 694 972 l 417 972 l 417 1111 l 694 1111 l 694 972 m 417 972 l 417 556 l 556 556 l 556 417 l 417 417 l 417 -139 l 278 -139 l 278 417 l 139 417 l 139 556 l 278 556 l 278 972 l 417 972 m 278 -139 l 278 -278 l 0 -278 l 0 -139 l 278 -139 z "},"£":{"ha":833,"x_min":0,"x_max":694,"o":"m 556 833 l 278 833 l 278 972 l 556 972 l 556 833 m 278 833 l 278 556 l 556 556 l 556 417 l 278 417 l 278 139 l 694 139 l 694 0 l 0 0 l 0 139 l 139 139 l 139 417 l 0 417 l 0 556 l 139 556 l 139 833 l 278 833 m 556 694 l 556 833 l 694 833 l 694 694 l 556 694 z "},"¥":{"ha":833,"x_min":0,"x_max":694,"o":"m 139 972 l 139 833 l 0 833 l 0 972 l 139 972 m 694 833 l 556 833 l 556 972 l 694 972 l 694 833 m 278 833 l 278 694 l 139 694 l 139 833 l 278 833 m 556 694 l 417 694 l 417 833 l 556 833 l 556 694 m 417 694 l 417 556 l 694 556 l 694 417 l 417 417 l 417 278 l 694 278 l 694 139 l 417 139 l 417 0 l 278 0 l 278 139 l 0 139 l 0 278 l 278 278 l 278 417 l 0 417 l 0 556 l 278 556 l 278 694 l 417 694 z "},"+":{"ha":833,"x_min":0,"x_max":694,"o":"m 694 417 l 417 417 l 417 139 l 278 139 l 278 417 l 0 417 l 0 556 l 278 556 l 278 833 l 417 833 l 417 556 l 694 556 l 694 417 z "},"−":{"ha":833,"x_min":0,"x_max":694,"o":"m 694 417 l 0 417 l 0 556 l 694 556 l 694 417 z "},"×":{"ha":833,"x_min":0,"x_max":694,"o":"m 0 833 l 139 833 l 139 694 l 0 694 l 0 833 m 556 833 l 694 833 l 694 694 l 556 694 l 556 833 m 139 694 l 278 694 l 278 556 l 139 556 l 139 694 m 417 694 l 556 694 l 556 556 l 417 556 l 417 694 m 278 556 l 417 556 l 417 417 l 278 417 l 278 556 m 139 417 l 278 417 l 278 278 l 139 278 l 139 417 m 417 417 l 556 417 l 556 278 l 417 278 l 417 417 m 0 278 l 139 278 l 139 139 l 0 139 l 0 278 m 556 278 l 694 278 l 694 139 l 556 139 l 556 278 z "},"÷":{"ha":833,"x_min":0,"x_max":694,"o":"m 417 694 l 278 694 l 278 833 l 417 833 l 417 694 m 694 417 l 0 417 l 0 556 l 694 556 l 694 417 m 278 278 l 417 278 l 417 139 l 278 139 l 278 278 z "},"=":{"ha":833,"x_min":0,"x_max":694,"o":"m 694 556 l 0 556 l 0 694 l 694 694 l 694 556 m 694 278 l 0 278 l 0 417 l 694 417 l 694 278 z "},"≠":{"ha":833,"x_min":0,"x_max":694,"o":"m 417 417 l 694 417 l 694 278 l 278 278 l 278 139 l 139 139 l 139 278 l 0 278 l 0 417 l 278 417 l 278 556 l 0 556 l 0 694 l 417 694 l 417 833 l 556 833 l 556 694 l 694 694 l 694 556 l 417 556 l 417 417 z "},">":{"ha":833,"x_min":139,"x_max":556,"o":"m 139 833 l 278 833 l 278 694 l 139 694 l 139 833 m 278 694 l 417 694 l 417 556 l 278 556 l 278 694 m 417 556 l 556 556 l 556 417 l 417 417 l 417 556 m 278 417 l 417 417 l 417 278 l 278 278 l 278 417 m 139 278 l 278 278 l 278 139 l 139 139 l 139 278 z "},"<":{"ha":833,"x_min":139,"x_max":556,"o":"m 417 833 l 556 833 l 556 694 l 417 694 l 417 833 m 278 694 l 417 694 l 417 556 l 278 556 l 278 694 m 139 556 l 278 556 l 278 417 l 139 417 l 139 556 m 278 417 l 417 417 l 417 278 l 278 278 l 278 417 m 417 278 l 556 278 l 556 139 l 417 139 l 417 278 z "},"≥":{"ha":833,"x_min":0,"x_max":694,"o":"m 278 972 l 278 833 l 139 833 l 139 972 l 278 972 m 417 833 l 417 694 l 278 694 l 278 833 l 417 833 m 556 556 l 417 556 l 417 694 l 556 694 l 556 556 m 417 417 l 278 417 l 278 556 l 417 556 l 417 417 m 278 278 l 139 278 l 139 417 l 278 417 l 278 278 m 694 0 l 0 0 l 0 139 l 694 139 l 694 0 z "},"≤":{"ha":833,"x_min":0,"x_max":694,"o":"m 556 833 l 417 833 l 417 972 l 556 972 l 556 833 m 417 694 l 278 694 l 278 833 l 417 833 l 417 694 m 278 556 l 139 556 l 139 694 l 278 694 l 278 556 m 278 417 l 278 556 l 417 556 l 417 417 l 278 417 m 417 278 l 417 417 l 556 417 l 556 278 l 417 278 m 694 0 l 0 0 l 0 139 l 694 139 l 694 0 z "},"±":{"ha":833,"x_min":0,"x_max":694,"o":"m 694 556 l 417 556 l 417 278 l 278 278 l 278 556 l 0 556 l 0 694 l 278 694 l 278 972 l 417 972 l 417 694 l 694 694 l 694 556 m 694 0 l 0 0 l 0 139 l 694 139 l 694 0 z "},"≈":{"ha":833,"x_min":0,"x_max":694,"o":"z "},"¬":{"ha":833,"x_min":0,"x_max":694,"o":"m 694 278 l 556 278 l 556 417 l 0 417 l 0 556 l 694 556 l 694 278 z "},"~":{"ha":833,"x_min":0,"x_max":694,"o":"m 139 556 l 347 556 l 347 417 l 139 417 l 139 556 m 556 556 l 694 556 l 694 417 l 556 417 l 556 556 m 0 417 l 139 417 l 139 278 l 0 278 l 0 417 m 347 417 l 556 417 l 556 278 l 347 278 l 347 417 z "},"^":{"ha":833,"x_min":0,"x_max":694,"o":"m 278 1111 l 417 1111 l 417 972 l 278 972 l 278 1111 m 139 972 l 278 972 l 278 833 l 139 833 l 139 972 m 417 972 l 556 972 l 556 833 l 417 833 l 417 972 m 0 833 l 139 833 l 139 694 l 0 694 l 0 833 m 556 833 l 694 833 l 694 694 l 556 694 l 556 833 z "},"∞":{"ha":833,"x_min":-139,"x_max":833,"o":"m 0 694 l 0 833 l 278 833 l 278 694 l 0 694 m 417 694 l 417 833 l 694 833 l 694 694 l 417 694 m 0 417 l -139 417 l -139 694 l 0 694 l 0 417 m 417 417 l 278 417 l 278 694 l 417 694 l 417 417 m 833 694 l 833 417 l 694 417 l 694 694 l 833 694 m 278 417 l 278 278 l 0 278 l 0 417 l 278 417 m 694 417 l 694 278 l 417 278 l 417 417 l 694 417 z "},"∫":{"ha":833,"x_min":0,"x_max":694,"o":"m 694 972 l 417 972 l 417 1111 l 694 1111 l 694 972 m 417 972 l 417 -139 l 278 -139 l 278 972 l 417 972 m 278 -139 l 278 -278 l 0 -278 l 0 -139 l 278 -139 z "},"∏":{"ha":833,"x_min":0,"x_max":694,"o":"m 694 972 l 556 972 l 556 -139 l 417 -139 l 417 972 l 278 972 l 278 -139 l 139 -139 l 139 972 l 0 972 l 0 1111 l 694 1111 l 694 972 z "},"∑":{"ha":833,"x_min":0,"x_max":694,"o":"m 139 833 l 0 833 l 0 1111 l 694 1111 l 694 972 l 139 972 l 139 833 m 139 694 l 139 833 l 278 833 l 278 694 l 139 694 m 278 556 l 278 694 l 417 694 l 417 556 l 278 556 m 417 417 l 417 556 l 556 556 l 556 417 l 417 417 m 278 417 l 417 417 l 417 278 l 278 278 l 278 417 m 139 278 l 278 278 l 278 139 l 139 139 l 139 278 m 139 139 l 139 0 l 694 0 l 694 -139 l 0 -139 l 0 139 l 139 139 z "},"√":{"ha":833,"x_min":0,"x_max":694,"o":"m 694 1111 l 694 694 l 556 694 l 556 1111 l 694 1111 m 556 694 l 556 278 l 417 278 l 417 694 l 556 694 m 417 278 l 417 -139 l 278 -139 l 278 278 l 417 278 m 139 0 l 139 -139 l 0 -139 l 0 0 l 139 0 m 139 -139 l 278 -139 l 278 -278 l 139 -278 l 139 -139 z "},"µ":{"ha":833,"x_min":0,"x_max":694,"o":"m 556 0 l 139 0 l 139 -278 l 0 -278 l 0 694 l 139 694 l 139 139 l 556 139 l 556 0 m 694 694 l 694 139 l 556 139 l 556 694 l 694 694 z "},"∂":{"ha":833,"x_min":0,"x_max":694,"o":"m 556 972 l 556 833 l 417 833 l 417 972 l 556 972 m 694 833 l 694 139 l 556 139 l 556 417 l 139 417 l 139 556 l 556 556 l 556 833 l 694 833 m 139 139 l 0 139 l 0 417 l 139 417 l 139 139 m 556 0 l 139 0 l 139 139 l 556 139 l 556 0 z "},"%":{"ha":833,"x_min":0,"x_max":694,"o":"m 278 833 l 139 833 l 139 972 l 417 972 l 417 694 l 278 694 l 278 833 m 694 972 l 694 694 l 556 694 l 556 972 l 694 972 m 278 694 l 278 556 l 0 556 l 0 833 l 139 833 l 139 694 l 278 694 m 417 694 l 556 694 l 556 556 l 417 556 l 417 694 m 278 556 l 417 556 l 417 417 l 278 417 l 278 556 m 278 417 l 278 278 l 139 278 l 139 417 l 278 417 m 417 278 l 417 417 l 694 417 l 694 139 l 556 139 l 556 278 l 417 278 m 139 278 l 139 0 l 0 0 l 0 278 l 139 278 m 417 139 l 556 139 l 556 0 l 278 0 l 278 278 l 417 278 l 417 139 z "},"‰":{"ha":833,"x_min":0,"x_max":1111,"o":"m 278 833 l 139 833 l 139 972 l 417 972 l 417 694 l 278 694 l 278 833 m 556 694 l 556 972 l 694 972 l 694 694 l 556 694 m 278 694 l 278 556 l 0 556 l 0 833 l 139 833 l 139 694 l 278 694 m 417 556 l 417 694 l 556 694 l 556 556 l 417 556 m 417 417 l 278 417 l 278 556 l 417 556 l 417 417 m 278 417 l 278 278 l 139 278 l 139 417 l 278 417 m 833 139 l 972 139 l 972 0 l 694 0 l 694 139 l 556 139 l 556 278 l 417 278 l 417 417 l 694 417 l 694 278 l 833 278 l 833 139 m 1111 139 l 972 139 l 972 278 l 833 278 l 833 417 l 1111 417 l 1111 139 m 139 278 l 139 0 l 0 0 l 0 278 l 139 278 m 417 139 l 556 139 l 556 0 l 278 0 l 278 278 l 417 278 l 417 139 z "},"↑":{"ha":833,"x_min":0,"x_max":694,"o":"m 556 833 l 556 694 l 417 694 l 417 0 l 278 0 l 278 694 l 139 694 l 139 833 l 278 833 l 278 972 l 417 972 l 417 833 l 556 833 m 0 694 l 139 694 l 139 556 l 0 556 l 0 694 m 694 694 l 694 556 l 556 556 l 556 694 l 694 694 z "},"↗":{"ha":833,"x_min":0,"x_max":694,"o":"m 694 278 l 556 278 l 556 556 l 417 556 l 417 694 l 139 694 l 139 833 l 694 833 l 694 278 m 278 556 l 417 556 l 417 417 l 278 417 l 278 556 m 139 417 l 278 417 l 278 278 l 139 278 l 139 417 m 0 278 l 139 278 l 139 139 l 0 139 l 0 278 z "},"→":{"ha":833,"x_min":-139,"x_max":833,"o":"m 556 833 l 556 694 l 417 694 l 417 833 l 556 833 m 833 556 l 833 417 l 694 417 l 694 278 l 556 278 l 556 417 l -139 417 l -139 556 l 556 556 l 556 694 l 694 694 l 694 556 l 833 556 m 417 278 l 556 278 l 556 139 l 417 139 l 417 278 z "},"↘":{"ha":833,"x_min":0,"x_max":694,"o":"m 139 833 l 139 694 l 0 694 l 0 833 l 139 833 m 694 694 l 694 139 l 139 139 l 139 278 l 417 278 l 417 417 l 556 417 l 556 694 l 694 694 m 278 694 l 278 556 l 139 556 l 139 694 l 278 694 m 417 556 l 417 417 l 278 417 l 278 556 l 417 556 z "},"↓":{"ha":833,"x_min":0,"x_max":694,"o":"m 556 278 l 556 139 l 417 139 l 417 0 l 278 0 l 278 139 l 139 139 l 139 278 l 278 278 l 278 972 l 417 972 l 417 278 l 556 278 m 139 417 l 139 278 l 0 278 l 0 417 l 139 417 m 694 417 l 694 278 l 556 278 l 556 417 l 694 417 z "},"↙":{"ha":833,"x_min":0,"x_max":694,"o":"m 694 833 l 694 694 l 556 694 l 556 833 l 694 833 m 278 417 l 278 278 l 556 278 l 556 139 l 0 139 l 0 694 l 139 694 l 139 417 l 278 417 m 417 694 l 556 694 l 556 556 l 417 556 l 417 694 m 278 556 l 417 556 l 417 417 l 278 417 l 278 556 z "},"←":{"ha":833,"x_min":-139,"x_max":833,"o":"m 278 694 l 139 694 l 139 833 l 278 833 l 278 694 m 833 417 l 139 417 l 139 278 l 0 278 l 0 417 l -139 417 l -139 556 l 0 556 l 0 694 l 139 694 l 139 556 l 833 556 l 833 417 m 139 139 l 139 278 l 278 278 l 278 139 l 139 139 z "},"↖":{"ha":833,"x_min":0,"x_max":694,"o":"m 278 556 l 139 556 l 139 278 l 0 278 l 0 833 l 556 833 l 556 694 l 278 694 l 278 556 m 417 556 l 417 417 l 278 417 l 278 556 l 417 556 m 556 417 l 556 278 l 417 278 l 417 417 l 556 417 m 694 278 l 694 139 l 556 139 l 556 278 l 694 278 z "},"↔":{"ha":833,"x_min":-139,"x_max":833,"o":"m 278 694 l 139 694 l 139 833 l 278 833 l 278 694 m 556 833 l 556 694 l 417 694 l 417 833 l 556 833 m 833 556 l 833 417 l 694 417 l 694 278 l 556 278 l 556 417 l 139 417 l 139 278 l 0 278 l 0 417 l -139 417 l -139 556 l 0 556 l 0 694 l 139 694 l 139 556 l 556 556 l 556 694 l 694 694 l 694 556 l 833 556 m 139 139 l 139 278 l 278 278 l 278 139 l 139 139 m 417 278 l 556 278 l 556 139 l 417 139 l 417 278 z "},"↕":{"ha":833,"x_min":0,"x_max":694,"o":"m 556 833 l 556 694 l 417 694 l 417 278 l 556 278 l 556 139 l 417 139 l 417 0 l 278 0 l 278 139 l 139 139 l 139 278 l 278 278 l 278 694 l 139 694 l 139 833 l 278 833 l 278 972 l 417 972 l 417 833 l 556 833 m 0 694 l 139 694 l 139 556 l 0 556 l 0 694 m 556 556 l 556 694 l 694 694 l 694 556 l 556 556 m 139 417 l 139 278 l 0 278 l 0 417 l 139 417 m 694 278 l 556 278 l 556 417 l 694 417 l 694 278 z "},"◊":{"ha":833,"x_min":0,"x_max":694,"o":"m 417 833 l 278 833 l 278 972 l 417 972 l 417 833 m 278 694 l 139 694 l 139 833 l 278 833 l 278 694 m 417 694 l 417 833 l 556 833 l 556 694 l 417 694 m 0 278 l 0 694 l 139 694 l 139 278 l 0 278 m 694 694 l 694 278 l 556 278 l 556 694 l 694 694 m 278 278 l 278 139 l 139 139 l 139 278 l 278 278 m 417 278 l 556 278 l 556 139 l 417 139 l 417 278 m 278 139 l 417 139 l 417 0 l 278 0 l 278 139 z "},"@":{"ha":833,"x_min":0,"x_max":694,"o":"m 556 833 l 139 833 l 139 972 l 556 972 l 556 833 m 139 833 l 139 139 l 0 139 l 0 833 l 139 833 m 694 833 l 694 278 l 278 278 l 278 694 l 556 694 l 556 833 l 694 833 m 556 556 l 417 556 l 417 417 l 556 417 l 556 556 m 139 139 l 694 139 l 694 0 l 139 0 l 139 139 z "},"&":{"ha":833,"x_min":0,"x_max":694,"o":"m 139 833 l 139 972 l 417 972 l 417 833 l 139 833 m 139 556 l 0 556 l 0 833 l 139 833 l 139 556 m 417 694 l 417 833 l 556 833 l 556 694 l 417 694 m 278 694 l 417 694 l 417 556 l 278 556 l 278 694 m 278 417 l 139 417 l 139 556 l 278 556 l 278 417 m 139 139 l 0 139 l 0 417 l 139 417 l 139 139 m 278 278 l 278 417 l 417 417 l 417 278 l 278 278 m 694 278 l 556 278 l 556 417 l 694 417 l 694 278 m 556 278 l 556 139 l 417 139 l 417 278 l 556 278 m 417 139 l 417 0 l 139 0 l 139 139 l 417 139 m 556 0 l 556 139 l 694 139 l 694 0 l 556 0 z "},"¶":{"ha":833,"x_min":0,"x_max":694,"o":"m 694 0 l 556 0 l 556 833 l 417 833 l 417 0 l 278 0 l 278 278 l 139 278 l 139 417 l 0 417 l 0 833 l 139 833 l 139 972 l 694 972 l 694 0 z "},"§":{"ha":833,"x_min":0,"x_max":694,"o":"m 139 972 l 694 972 l 694 833 l 139 833 l 139 972 m 139 833 l 139 694 l 0 694 l 0 833 l 139 833 m 139 694 l 556 694 l 556 556 l 139 556 l 139 694 m 139 556 l 139 417 l 0 417 l 0 556 l 139 556 m 556 417 l 556 556 l 694 556 l 694 417 l 556 417 m 556 278 l 139 278 l 139 417 l 556 417 l 556 278 m 556 139 l 556 278 l 694 278 l 694 139 l 556 139 m 556 0 l 0 0 l 0 139 l 556 139 l 556 0 z "},"©":{"ha":833,"x_min":0,"x_max":833,"o":"m 833 833 l 833 139 l 694 139 l 694 0 l 139 0 l 139 139 l 0 139 l 0 833 l 139 833 l 139 972 l 694 972 l 694 833 l 833 833 m 694 694 l 556 694 l 556 833 l 278 833 l 278 694 l 139 694 l 139 278 l 278 278 l 278 139 l 556 139 l 556 278 l 694 278 l 694 417 l 556 417 l 556 278 l 278 278 l 278 694 l 556 694 l 556 556 l 694 556 l 694 694 z "},"®":{"ha":833,"x_min":0,"x_max":833,"o":"m 833 833 l 833 139 l 694 139 l 694 278 l 556 278 l 556 417 l 694 417 l 694 694 l 556 694 l 556 833 l 139 833 l 139 972 l 694 972 l 694 833 l 833 833 m 0 139 l 0 833 l 139 833 l 139 139 l 0 139 m 556 694 l 556 417 l 278 417 l 278 694 l 556 694 m 556 139 l 694 139 l 694 0 l 139 0 l 139 139 l 278 139 l 278 278 l 556 278 l 556 139 z "},"℗":{"ha":833,"x_min":0,"x_max":833,"o":"m 833 833 l 833 139 l 694 139 l 694 0 l 139 0 l 139 139 l 278 139 l 278 278 l 556 278 l 556 417 l 694 417 l 694 694 l 556 694 l 556 833 l 139 833 l 139 972 l 694 972 l 694 833 l 833 833 m 0 139 l 0 833 l 139 833 l 139 139 l 0 139 m 556 694 l 556 417 l 278 417 l 278 694 l 556 694 z "},"™":{"ha":833,"x_min":0,"x_max":833,"o":"m 833 972 l 833 556 l 694 556 l 694 694 l 556 694 l 556 556 l 417 556 l 417 833 l 278 833 l 278 556 l 139 556 l 139 833 l 0 833 l 0 972 l 556 972 l 556 833 l 694 833 l 694 972 l 833 972 z "},"°":{"ha":833,"x_min":0,"x_max":556,"o":"m 139 972 l 139 1111 l 417 1111 l 417 972 l 139 972 m 139 694 l 0 694 l 0 972 l 139 972 l 139 694 m 556 972 l 556 694 l 417 694 l 417 972 l 556 972 m 417 694 l 417 556 l 139 556 l 139 694 l 417 694 z "},"|":{"ha":833,"x_min":278,"x_max":417,"o":"m 417 1111 l 417 -139 l 278 -139 l 278 1111 l 417 1111 z "},"¦":{"ha":833,"x_min":278,"x_max":417,"o":"m 417 1111 l 417 556 l 278 556 l 278 1111 l 417 1111 m 417 417 l 417 -139 l 278 -139 l 278 417 l 417 417 z "},"†":{"ha":833,"x_min":0,"x_max":694,"o":"m 694 694 l 417 694 l 417 -139 l 278 -139 l 278 694 l 0 694 l 0 833 l 278 833 l 278 1111 l 417 1111 l 417 833 l 694 833 l 694 694 z "},"‡":{"ha":833,"x_min":0,"x_max":694,"o":"m 694 278 l 694 139 l 417 139 l 417 -139 l 278 -139 l 278 139 l 0 139 l 0 278 l 278 278 l 278 694 l 0 694 l 0 833 l 278 833 l 278 1111 l 417 1111 l 417 833 l 694 833 l 694 694 l 417 694 l 417 278 l 694 278 z "},"̈":{"ha":0,"x_min":-694,"x_max":-278,"o":"m -694 972 l -556 972 l -556 833 l -694 833 l -694 972 m -417 972 l -278 972 l -278 833 l -417 833 l -417 972 z "},"̇":{"ha":0,"x_min":-556,"x_max":-417,"o":"m -556 972 l -417 972 l -417 833 l -556 833 l -556 972 z "},"̀":{"ha":0,"x_min":-694,"x_max":-417,"o":"m -694 1111 l -556 1111 l -556 972 l -694 972 l -694 1111 m -556 972 l -417 972 l -417 833 l -556 833 l -556 972 z "},"́":{"ha":0,"x_min":-556,"x_max":-278,"o":"m -417 1111 l -278 1111 l -278 972 l -417 972 l -417 1111 m -556 972 l -417 972 l -417 833 l -556 833 l -556 972 z "},"̋":{"ha":0,"x_min":-694,"x_max":-139,"o":"m -556 1111 l -417 1111 l -417 972 l -556 972 l -556 1111 m -278 1111 l -139 1111 l -139 972 l -278 972 l -278 1111 m -694 972 l -556 972 l -556 833 l -694 833 l -694 972 m -417 972 l -278 972 l -278 833 l -417 833 l -417 972 z "},"̂":{"ha":0,"x_min":-694,"x_max":-278,"o":"m -556 1111 l -417 1111 l -417 972 l -556 972 l -556 1111 m -694 972 l -556 972 l -556 833 l -694 833 l -694 972 m -417 972 l -278 972 l -278 833 l -417 833 l -417 972 z "},"̌":{"ha":0,"x_min":-694,"x_max":-278,"o":"m -694 1111 l -556 1111 l -556 972 l -694 972 l -694 1111 m -417 1111 l -278 1111 l -278 972 l -417 972 l -417 1111 m -556 972 l -417 972 l -417 833 l -556 833 l -556 972 z "},"̆":{"ha":0,"x_min":-694,"x_max":-139,"o":"m -556 1111 l -556 972 l -694 972 l -694 1111 l -556 1111 m -139 1111 l -139 972 l -278 972 l -278 1111 l -139 1111 m -278 972 l -278 833 l -556 833 l -556 972 l -278 972 z "},"̊":{"ha":0,"x_min":-694,"x_max":-278,"o":"m -556 1250 l -417 1250 l -417 1111 l -556 1111 l -556 1250 m -694 1111 l -556 1111 l -556 972 l -694 972 l -694 1111 m -417 1111 l -278 1111 l -278 972 l -417 972 l -417 1111 m -556 972 l -417 972 l -417 833 l -556 833 l -556 972 z "},"̃":{"ha":0,"x_min":-833,"x_max":-139,"o":"m -694 1111 l -486 1111 l -486 972 l -694 972 l -694 1111 m -278 1111 l -139 1111 l -139 972 l -278 972 l -278 1111 m -833 972 l -694 972 l -694 833 l -833 833 l -833 972 m -486 972 l -278 972 l -278 833 l -486 833 l -486 972 z "},"̄":{"ha":0,"x_min":-694,"x_max":-278,"o":"m -278 833 l -694 833 l -694 972 l -278 972 l -278 833 z "},"̒":{"ha":0,"x_min":-556,"x_max":-278,"o":"m -417 1111 l -278 1111 l -278 972 l -417 972 l -417 1111 m -556 972 l -417 972 l -417 833 l -556 833 l -556 972 z "},"̦":{"ha":0,"x_min":-694,"x_max":-417,"o":"m -556 -139 l -417 -139 l -417 -278 l -556 -278 l -556 -139 m -694 -278 l -556 -278 l -556 -417 l -694 -417 l -694 -278 z "},"̧":{"ha":0,"x_min":-694,"x_max":-278,"o":"m -417 139 l -417 0 l -556 0 l -556 139 l -417 139 m -278 0 l -278 -139 l -417 -139 l -417 0 l -278 0 m -417 -139 l -417 -278 l -694 -278 l -694 -139 l -417 -139 z "},"̨":{"ha":0,"x_min":-417,"x_max":0,"o":"m -139 0 l -278 0 l -278 139 l -139 139 l -139 0 m -278 0 l -278 -139 l -417 -139 l -417 0 l -278 0 m 0 -278 l -278 -278 l -278 -139 l 0 -139 l 0 -278 z "},"̵":{"ha":0,"x_min":-556,"x_max":0,"o":"m 0 694 l -556 694 l -556 833 l 0 833 l 0 694 z "},"̶":{"ha":0,"x_min":-972,"x_max":0,"o":"m 0 694 l -972 694 l -972 833 l 0 833 l 0 694 z "},"̷":{"ha":0,"x_min":-833,"x_max":-417,"o":"m -417 417 l -556 417 l -556 278 l -833 278 l -833 417 l -694 417 l -694 556 l -417 556 l -417 417 z "},"̸":{"ha":0,"x_min":-833,"x_max":-139,"o":"m -278 694 l -139 694 l -139 556 l -278 556 l -278 694 m -417 556 l -278 556 l -278 417 l -417 417 l -417 556 m -556 417 l -417 417 l -417 278 l -556 278 l -556 417 m -694 278 l -556 278 l -556 139 l -694 139 l -694 278 m -833 139 l -694 139 l -694 0 l -833 0 l -833 139 z "},"´":{"ha":833,"x_min":139,"x_max":556,"o":"m 417 1111 l 556 1111 l 556 972 l 417 972 l 417 1111 m 278 972 l 417 972 l 417 833 l 278 833 l 278 972 m 139 833 l 278 833 l 278 694 l 139 694 l 139 833 z "},"˘":{"ha":833,"x_min":139,"x_max":694,"o":"m 278 1111 l 278 972 l 139 972 l 139 1111 l 278 1111 m 694 1111 l 694 972 l 556 972 l 556 1111 l 694 1111 m 556 972 l 556 833 l 278 833 l 278 972 l 556 972 z "},"ˇ":{"ha":833,"x_min":139,"x_max":556,"o":"m 139 1111 l 278 1111 l 278 972 l 139 972 l 139 1111 m 417 1111 l 556 1111 l 556 972 l 417 972 l 417 1111 m 278 972 l 417 972 l 417 833 l 278 833 l 278 972 z "},"¸":{"ha":833,"x_min":139,"x_max":556,"o":"m 417 139 l 417 0 l 278 0 l 278 139 l 417 139 m 556 0 l 556 -139 l 417 -139 l 417 0 l 556 0 m 417 -139 l 417 -278 l 139 -278 l 139 -139 l 417 -139 z "},"ˆ":{"ha":833,"x_min":139,"x_max":556,"o":"m 278 1111 l 417 1111 l 417 972 l 278 972 l 278 1111 m 139 972 l 278 972 l 278 833 l 139 833 l 139 972 m 417 972 l 556 972 l 556 833 l 417 833 l 417 972 z "},"¨":{"ha":833,"x_min":139,"x_max":556,"o":"m 139 972 l 278 972 l 278 833 l 139 833 l 139 972 m 417 972 l 556 972 l 556 833 l 417 833 l 417 972 z "},"˙":{"ha":833,"x_min":278,"x_max":417,"o":"m 278 972 l 417 972 l 417 833 l 278 833 l 278 972 z "},"`":{"ha":833,"x_min":139,"x_max":556,"o":"m 139 1111 l 278 1111 l 278 972 l 139 972 l 139 1111 m 278 972 l 417 972 l 417 833 l 278 833 l 278 972 m 417 833 l 556 833 l 556 694 l 417 694 l 417 833 z "},"˝":{"ha":833,"x_min":139,"x_max":694,"o":"m 278 1111 l 417 1111 l 417 972 l 278 972 l 278 1111 m 556 1111 l 694 1111 l 694 972 l 556 972 l 556 1111 m 139 972 l 278 972 l 278 833 l 139 833 l 139 972 m 417 972 l 556 972 l 556 833 l 417 833 l 417 972 z "},"¯":{"ha":833,"x_min":0,"x_max":694,"o":"m 694 833 l 0 833 l 0 972 l 694 972 l 694 833 z "},"˛":{"ha":833,"x_min":417,"x_max":833,"o":"m 694 0 l 556 0 l 556 139 l 694 139 l 694 0 m 556 0 l 556 -139 l 417 -139 l 417 0 l 556 0 m 833 -278 l 556 -278 l 556 -139 l 833 -139 l 833 -278 z "},"˚":{"ha":833,"x_min":139,"x_max":556,"o":"m 278 1250 l 417 1250 l 417 1111 l 278 1111 l 278 1250 m 139 1111 l 278 1111 l 278 972 l 139 972 l 139 1111 m 417 1111 l 556 1111 l 556 972 l 417 972 l 417 1111 m 278 972 l 417 972 l 417 833 l 278 833 l 278 972 z "},"˜":{"ha":833,"x_min":0,"x_max":694,"o":"m 139 1111 l 347 1111 l 347 972 l 139 972 l 139 1111 m 556 1111 l 694 1111 l 694 972 l 556 972 l 556 1111 m 0 972 l 139 972 l 139 833 l 0 833 l 0 972 m 347 972 l 556 972 l 556 833 l 347 833 l 347 972 z "}},"familyName":"undefined medium","ascender":1111,"descender":-278,"underlinePosition":-104,"underlineThickness":69,"boundingBox":{"yMin":-417,"xMin":-972,"yMax":1528,"xMax":1528},"resolution":1000,"original_font_information":{"format":0,"copyright":"Copyright (c) 2018-2019 by Andi Rueckel. All rights reserved.","fontFamily":"undefined medium","fontSubfamily":"Regular","uniqueID":"1.000;UKWN;undefined-medium","fullName":"undefined medium","version":"Version 1.000","postScriptName":"undefined-medium","manufacturer":"Andi Rueckel","designer":"Andi Rueckel","manufacturerURL":"https://andirueckel.com","designerURL":"https://andirueckel.com","licence":"SIL Open Font License v1.1","licenceURL":"https://scripts.sil.org/OFL","preferredFamily":"undefined","preferredSubfamily":"medium"},"cssFontWeight":"normal","cssFontStyle":"normal"};
var names = [
    "Alan Bouzek",
    "Corbin Carter",
    "Thomas Coladonato",
    "Matt Helgren",
    "Vance Henize",
    "Volodymyr Ilchenko",
    "Taras Kontsur",
    "Bohdan Kovalchuk",
    "Kateryna Kravchyshyn",
    "Yevgen Kruglyk",
    "Jonathan Lopez",
    "Derek Mikish",
    "Raul Murguia",
    "Anastasiia Novosad",
    "Oleksandr Pavlyna",
    "Roman Petrukhiv",
    "Roman Kozak",
    "Petro Rovenskyy",
    "Andriy Sapryka",
    "Charles Schad",
    "Daria Shekhovtsova",
    "Carl Smoot",
    "Artur Synhalevych",
    "Clyde Tarver",
    "Tetiana Pavlius",
    "Andriy Tkachuk",
    "Volodymyr Tsaryk",
    "Volodymyr Tymoshchuk",
    "Oleksandr Vol",
    "Yuriy Voytovych",
    "John Waycuilis",
    "Adrian Weisberg",
    "Damon E. Williams",
    "John Wisneski",
    "Zack Yao",
    "Dave Youmans",
    "Oleh Zimokha"
];
var UP = false;
var DOWN = false;
var LEFT = false;
var RIGHT = false;

var R;
var G;
var B;

var RKey = 82;
var GKey = 71;
var BKey = 66;

{ // Bind key handlers
    var leftKeys = ["37", "65"];
    var upKeys = ["38", "87"];
    var rightKeys = ["39", "68"];
    var downKeys = ["40", "83"];

    var keyHandlerBlob = {};

    [
        [(val) => LEFT = val, leftKeys],
        [(val) => UP = val, upKeys],
        [(val) => RIGHT = val, rightKeys],
        [(val) => DOWN = val, downKeys]
    ]
        .forEach(
            ([stateVarUpdater, keyCodes]) => {
                keyCodes.forEach(
                    keyCode => {
                        keyHandlerBlob[keyCode] = {
                            state: false,
                            updater: () => {
                                stateVarUpdater(keyCodes.map(kc => keyHandlerBlob[kc].state).reduce((acc, val) => acc || val, false));
                            }
                        }
                    }
                )
            }
        );

    document.addEventListener('keydown', function (e) {
        if(e.which === RKey && R){
            R.visible = !R.visible;
        } else if (e.which === GKey && G){
            G.visible = !G.visible;
        } else if (e.which === BKey && B){
            B.visible = !B.visible;
        }

        Object.keys(keyHandlerBlob).some(
            kc => {
                if ("" + e.which === kc) {
                    keyHandlerBlob[kc].state = true;
                    keyHandlerBlob[kc].updater();
                    return true;
                }
                return false;
            }
        );
    });

    document.addEventListener('keyup', function (e) {
        Object.keys(keyHandlerBlob).some(
            kc => {
                if ("" + e.which === kc) {
                    keyHandlerBlob[kc].state = false;
                    keyHandlerBlob[kc].updater();
                    return true;
                }
                return false;
            }
        );
    });
}

var scene = new THREE.Scene();

var camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 1000);
{ // SETUP CAMERA
    camera.position.x = 3.9 / 2;
    camera.position.y = 12 / 2;
    camera.position.z = 20 / 2;
    camera.up = new THREE.Vector3(1, 0, 0);
}

var canvas = document.createElement('canvas');

var renderer = new THREE.WebGLRenderer( {alpha: true, canvas });
canvas.style.width = '100vw';
canvas.style.height = '100vh';
canvas.style.top = '0';
canvas.style.left = '0';
canvas.style.pointerEvents = 'none';
canvas.style.position = 'absolute';
renderer.setClearColor(0x000000, 0);

var effect = new THREE.OutlineEffect(renderer, {
    defaultThickness: 0.0075,
    defaultColor: [0,0,0],
    defaultAlpha: 0.8,
    defaultKeepAlive: true
});
{ // SETUP RENDERER
    renderer.setSize(window.innerWidth, window.innerHeight);
    document.body.appendChild(renderer.domElement);

    { // SETUP RENDERER SHADOW MAPPING
        renderer.shadowMap.enabled = true;
        renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    }
}

var cubeMaterial = new THREE.MeshPhongMaterial({
    color: 0x888888,
    shininess: 3,
    specular: 0xbbbbbb,
    emissive: 0x080808,
    opacity: 1,
    transparent: true
});

cubeMaterial.userData.outlineParameters = {
    thickness: 0.00,
    color: [ 0, 0, 0 ],
    alpha: 0.8,
    visible: false,
    keepAlive: true
};

const CUBE_WIDTH = 3;

var rootCube = new THREE.Mesh(
    new THREE.BoxGeometry(CUBE_WIDTH, CUBE_WIDTH, CUBE_WIDTH),
    cubeMaterial
);
rootCube.castShadow = true;
rootCube.receiveShadow = true;


var ALL_SUB_CUBES = [];
{ // SETUP SUB CUBES AND ATTACH TO ROOT CUBE
    var subCubes = [];
    var buildSubCube = (attachmentPoint, edgeLength, differential, aggregator, originalOffset) => {
        var subGeo = new THREE.BoxGeometry(edgeLength, edgeLength, edgeLength);
        var subCube = new THREE.Mesh(subGeo, cubeMaterial);
        subCube.ORIGINAL_OFFSET = originalOffset;
        subCube.castShadow = true;
        subCube.receiveShadow = true;
        differential(subCube.position);
        subCube.ORIGINAL_POSITION = new THREE.Vector3();
        differential(subCube.ORIGINAL_POSITION);
        attachmentPoint.add(subCube);
        ALL_SUB_CUBES.push(subCube);
        aggregator.push(subCube);
    };

    let subCubeWidth = CUBE_WIDTH / 3;
    let subCubeOffset = CUBE_WIDTH / 2 + 3 * subCubeWidth / 2;

    buildSubCube(rootCube, subCubeWidth, sc => sc.x = subCubeOffset, subCubes, subCubeOffset);
    buildSubCube(rootCube, subCubeWidth, sc => sc.x = -subCubeOffset, subCubes, subCubeOffset);

    buildSubCube(rootCube, subCubeWidth, sc => sc.y = subCubeOffset, subCubes, subCubeOffset);
    buildSubCube(rootCube, subCubeWidth, sc => sc.y = -subCubeOffset, subCubes, subCubeOffset);

    buildSubCube(rootCube, subCubeWidth, sc => sc.z = subCubeOffset, subCubes, subCubeOffset);
    buildSubCube(rootCube, subCubeWidth, sc => sc.z = -subCubeOffset, subCubes, subCubeOffset);

    let lastCubeWidth = subCubeWidth;
    subCubeWidth = lastCubeWidth / 3;
    subCubeOffset = lastCubeWidth / 2 + 3 * subCubeWidth / 2;

    var subsubCubes = [];
    subCubes.map(sc => {
        buildSubCube(sc, subCubeWidth, ssc => ssc.x = subCubeOffset, subsubCubes, subCubeOffset);
        buildSubCube(sc, subCubeWidth, ssc => ssc.x = -subCubeOffset, subsubCubes, subCubeOffset);

        buildSubCube(sc, subCubeWidth, ssc => ssc.y = subCubeOffset, subsubCubes, subCubeOffset);
        buildSubCube(sc, subCubeWidth, ssc => ssc.y = -subCubeOffset, subsubCubes, subCubeOffset);

        buildSubCube(sc, subCubeWidth, ssc => ssc.z = subCubeOffset, subsubCubes, subCubeOffset);
        buildSubCube(sc, subCubeWidth, ssc => ssc.z = -subCubeOffset, subsubCubes, subCubeOffset);
    });
    lastCubeWidth = subCubeWidth;
    subCubeWidth = lastCubeWidth / 3;
    subCubeOffset = lastCubeWidth / 2 + 3 * subCubeWidth / 2;
    subsubCubes.map(ssc => {
        buildSubCube(ssc, subCubeWidth, sssc => sssc.x = subCubeOffset, [], subCubeOffset);
        buildSubCube(ssc, subCubeWidth, sssc => sssc.x = -subCubeOffset, [], subCubeOffset);

        buildSubCube(ssc, subCubeWidth, sssc => sssc.y = subCubeOffset, [], subCubeOffset);
        buildSubCube(ssc, subCubeWidth, sssc => sssc.y = -subCubeOffset, [], subCubeOffset);

        buildSubCube(ssc, subCubeWidth, sssc => sssc.z = subCubeOffset, [], subCubeOffset);
        buildSubCube(ssc, subCubeWidth, sssc => sssc.z = -subCubeOffset, [], subCubeOffset);
    })
}
scene.add(rootCube);

{// ADD FLOOR (actually a globe heh)

    // ADD SHADOW NET
    var shadowMat = new THREE.ShadowMaterial();
    shadowMat.userData.outlineParameters = {
        thickness: 0.00,
        color: [ 0, 0, 0 ],
        alpha: 0.8,
        visible: false,
        keepAlive: true
    };
    shadowMat.opacity = .3;
    // var shadowMat = new THREE.MeshPhongMaterial();
    var shadowGeom = new THREE.PlaneBufferGeometry(10000, 10000, 2, 2);
    var plane = new THREE.Mesh(shadowGeom, shadowMat);
    plane.position.z = -10;
    plane.position.y = -15;
    plane.receiveShadow = true;
    // plane.lookAt(camera.position);
    scene.add(plane);

    // var galacticFloorGeom = new THREE.PlaneBufferGeometry(10000, 10000, 2, 2);
    // var galacticFloorMat = new THREE.MeshPhongMaterial(
    //     { color: 0xaaaaff, shininess: 20 }
    // );
    // var plane = new THREE.Mesh(galacticFloorGeom, galacticFloorMat);
    // plane.position.x = -8;
    // plane.setRotationFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);
    //
    // plane.receiveShadow = true;
    // // scene.add(plane);
    //
    // var galacticFirmamentGeom = new THREE.SphereBufferGeometry(20, 80, 80);
    // var galacticFirmamentMat = new THREE.MeshPhongMaterial(
    //     { color: 0xaaaaff, shininess: 20 }
    // );
    // galacticFirmamentMat.side = THREE.BackSide;
    // var firmament = new THREE.Mesh(galacticFirmamentGeom, galacticFirmamentMat);
    //
    // firmament.receiveShadow = true;
    // // scene.add(firmament);
}

var particleLights = [];
{// LIGHTING
    scene.add(new THREE.AmbientLight(0x020804));

    var hemiLight = new THREE.HemisphereLight(
        0xaaaaaa,
        0x444444,
        .4
    );
    scene.add(hemiLight);

    const genAndAddParticleLight = (color, position, surfColor = color) => {
        // var particleLight = new THREE.Mesh(
        //     new THREE.SphereBufferGeometry(.08, 12, 12),
        //     new THREE.MeshBasicMaterial({ color: surfColor })
        // );
        // particleLight.position.z = 3;
        var particleLight = new THREE.Group();

        var pointLight = new THREE.PointLight(color, 2, 26);
        pointLight.castShadow = true;

        pointLight.shadow.mapSize.width = 1024;
        pointLight.shadow.mapSize.height = 1024;
        pointLight.shadow.camera.near = 0.5;
        pointLight.shadow.camera.far = 500;

        particleLight.add(pointLight);

        Object.assign(particleLight.position, position);
        scene.add(particleLight);
        particleLights.push(particleLight);
        return particleLight;
    };

    R = genAndAddParticleLight(0xff0000, { x: 5 }, 0xff4444);
    G = genAndAddParticleLight(0x00ff00, { y: 5 }, 0x44ff44);
    // B = genAndAddParticleLight(0x0000ff, { z: 5 }, 0x4444ff);
}

//sloopy quat
var lQuat = new THREE.Quaternion();
lQuat.setFromAxisAngle(new THREE.Vector3(0, 1, 1), Math.PI / 2400).normalize();
camera.lookAt(rootCube.position);
rootCube.position.z = -1.5;

var font = new THREE.Font(undefined_medium);

var textWrapper = new THREE.Group();
textWrapper.rotation.x = -Math.PI/16;
textWrapper.up = new THREE.Vector3(0, 1, 0);
// textWrapper.lookAt(camera.position);

var nameOffset = -2;
var textMaterial = new THREE.MeshToonMaterial( {

});
const attachText = () => {
    // TEXT PROTOTYPE
    // textWrapper.children = [];
    nameOffset = (nameOffset + 1) % names.length;
    var textGeo = new THREE.TextGeometry(
        nameOffset > -1
            ? names[nameOffset]
            : 'GREETZ OUT TO THESE CODERZ'
        ,{
            font,
            size: 0.5,
            curveSegments: 32,
            height: 0.0725,
            height: 0.0725,
            bevelThickness: 0.05,
            bevelSize: 0,
            bevelSegments: 1,
            bevelEnabled: false
        }
    );
    textGeo.computeBoundingBox();
    textGeo.computeVertexNormals();
    var centerOffset = -0.5 * (textGeo.boundingBox.max.x - textGeo.boundingBox.min.x);
    textGeo = new THREE.BufferGeometry().fromGeometry(textGeo);
    var textMesh1 = new THREE.Mesh(textGeo, textMaterial);
    textMesh1.rotation.z = -Math.PI/2;
    textMesh1.rotation.y = Math.PI/16;
    // textMesh1.rotation.x = Math.PI/8;
    textMesh1.position.x = 5;
    textMesh1.position.y = -centerOffset;
    textMesh1.position.z = 3;
    textMesh1.castShadow = true;
    textWrapper.add(textMesh1);
};

scene.add(textWrapper);

let frameCounter = -1;
function animate() {
    requestAnimationFrame(animate);
    frameCounter += 1;

    canvas.style.width = '100vw';
    canvas.style.height = '100vh';

    textWrapper.children.forEach(child => {
        child.position.x -= 0.0125;
    });
    textWrapper.children = textWrapper.children.filter(child => child.position.x > -7);

    if(frameCounter % 80 == 0) {
        attachText();
    };

    particleLights.map((pl) => pl.position.applyQuaternion(lQuat));

    // var cQuat = new THREE.Quaternion();
    // cQuat.setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 300);

    // camera.position.applyQuaternion(cQuat);
    // camera.lookAt(rootCube.position);

    if(LEFT ^ RIGHT) {

        const sign = LEFT ? 1 : -1;

        // var dynamicQuaternion = new THREE.Quaternion();
        // dynamicQuaternion.setFromAxisAngle(particleLights[0].position.clone().sub(rootCube.position), sign * Math.PI / 1024).normalize();

        var quaternion = new THREE.Quaternion();
        quaternion.setFromAxisAngle(new THREE.Vector3(1, -1, 0), sign * .00625).normalize();
        // rootCube.applyQuaternion(dynamicQuaternion);
        rootCube.applyQuaternion(quaternion);
        // rootCube.applyQuaternion(lQuat);
    }

    if(UP ^ DOWN) {
        // var scalarScalor = 1 + ((UP * .0001) - (DOWN * .0001));
        //
        // console.log(scalarScalor);
        //
        // var scaleFactor = new THREE.Vector3(scalarScalor, scalarScalor, scalarScalor);

        ALL_SUB_CUBES.forEach(
            subCube => {
                // TODO this doesn't really "reverse" properly
                subCube.applyMatrix(
                    new THREE.Matrix4().compose(
                        new THREE.Vector3(0, 0, 0), // position
                        new THREE.Quaternion().setFromAxisAngle(
                            (
                                UP
                                    ? subCube.ORIGINAL_POSITION.clone()
                                    : subCube.ORIGINAL_POSITION.clone().negate()
                            ).normalize()
                            ,
                            .0125
                        ),
                        // scaleFactor
                        new THREE.Vector3(1, 1, 1)
                    )
                );
            }
        );
    }

    effect.render(scene, camera);
}
animate();