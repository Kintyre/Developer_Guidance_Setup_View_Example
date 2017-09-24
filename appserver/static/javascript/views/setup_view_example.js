"use strict";

define(
    ["backbone", "jquery", "splunkjs/splunk"],
    function(Backbone, jquery, splunk_js_sdk) {
        sdk = splunk_js_sdk;
        var ExampleView = Backbone.View.extend({
            // -----------------------------------------------------------------
            // Backbon Functions, These are specific to the Backbone library
            // -----------------------------------------------------------------
            initialize: function initialize() {
                Backbone.View.prototype.initialize.apply(this, arguments);
            },

            events: {
                "click .setup_button": "trigger_setup",
            },

            render: function() {
                this.el.innerHTML = this.get_template();

                return this;
            },

            // -----------------------------------------------------------------
            // Custom Functions, These are unrelated to the Backbone functions
            // -----------------------------------------------------------------
            // ----------------------------------
            // Main Setup Logic
            // ----------------------------------
            // This performs some sanity checking and cleanup on the inputs that
            // the user has provided before kicking off main setup process
            trigger_setup: function trigger_setup() {
                // Used to hide the error output, when a setup is retried
                this.display_error_output([]);

                console.log("Triggering setup");
                var api_url_input_element = jquery("input[name=api_url]");
                var api_url = api_url_input_element.val();
                var sanitized_api_url = this.sanitize_string(api_url);

                var api_key_input_element = jquery("input[name=api_key]");
                var api_key = api_key_input_element.val();
                var sanitized_api_key = this.sanitize_string(api_key);

                var error_messages_to_display = this.validate_inputs(
                    sanitized_api_url,
                    sanitized_api_key,
                );

                var did_error_messages_occur = error_messages_to_display.length > 0;
                if (did_error_messages_occur) {
                    // Displays the errors that occurred input validation
                    this.display_error_output(error_messages_to_display);
                } else {
                    var fully_qualified_url = "https://" + sanitized_api_url;
                    this.perform_setup(
                        splunk_js_sdk,
                        fully_qualified_url,
                        sanitized_api_key,
                    );
                }
            },

            // This is where the main setup process occurs
            perform_setup: async function perform_setup(splunk_js_sdk, api_url, api_key) {
                var app_name = "developer_guidance_setup_view";

                var application_name_space = {
                    owner: "nobody",
                    app: app_name,
                    sharing: "app",
                };

                try {
                    // Create the Splunk JS SDK Service object
                    splunk_js_sdk_service = this.create_splunk_js_sdk_service(
                        splunk_js_sdk,
                        application_name_space,
                    );
                    // Creates the custom configuration file of this Splunk App
                    // All required information for this Splunk App is placed in
                    // there
                    await this.create_custom_configuration_file(
                        splunk_js_sdk_service,
                        api_url,
                    );

                    // Creates the passwords.conf stanza that is the encryption
                    // of the api_key provided by the user
                    await this.encrypt_api_key(splunk_js_sdk_service, api_key);

                    // Completes the setup, by access the app.conf's [install]
                    // stanza and then setting the `is_configured` to true
                    await this.complete_setup(splunk_js_sdk_service);

                    // Reloads the splunk app so that splunk is aware of the
                    // updates made to the file system
                    await this.reload_splunk_app(splunk_js_sdk_service, app_name);

                    // Redirect to the Splunk App's home page
                    this.redirect_to_splunk_app_homepage(app_name);
                } catch (error) {
                    // This could be better error catching.
                    // Usually, error output that is ONLY relevant to the user
                    // should be displayed. This will return output that the
                    // user does not understand, causing them to be confused.
                    var error_messages_to_display = [];
                    if (
                        error !== null &&
                        typeof error === "object" &&
                        error.hasOwnProperty("responseText")
                    ) {
                        var response_object = JSON.parse(error.responseText);
                        error_messages_to_display = this.extract_error_messages(
                            response_object.messages,
                        );
                    } else {
                        // Assumed to be string
                        error_messages_to_display.push(error);
                    }

                    this.display_error_output(error_messages_to_display);
                }
            },

            create_custom_configuration_file: async function create_custom_configuration_file(
                splunk_js_sdk_service,
                api_url,
            ) {
                var custom_configuration_file_name = "setup_view_example";
                var stanza_name = "example_stanza";
                var properties_to_update = {
                    api_url: api_url,
                };

                await this.update_configuration_file(
                    splunk_js_sdk_service,
                    custom_configuration_file_name,
                    stanza_name,
                    properties_to_update,
                );
            },

            encrypt_api_key: async function encrypt_api_key(
                splunk_js_sdk_service,
                api_key,
            ) {
                // /servicesNS/<NAMESPACE_USERNAME>/<SPLUNK_APP_NAME>/storage/passwords/<REALM>%3A<USERNAME>%3A
                var realm = "setup_view_example_realm";
                var username = "admin";

                var storage_passwords_accessor = splunk_js_sdk_service.storagePasswords(
                    {
                        // No namespace information provided
                    },
                );
                await storage_passwords_accessor.fetch();

                var does_storage_password_exist = this.does_storage_password_exist(
                    storage_passwords_accessor,
                    realm,
                    username,
                );

                if (does_storage_password_exist) {
                    await this.delete_storage_password(
                        storage_passwords_accessor,
                        realm,
                        username,
                    );
                }
                await storage_passwords_accessor.fetch();

                await this.create_storage_password_stanza(
                    storage_passwords_accessor,
                    realm,
                    username,
                    api_key,
                );
            },

            complete_setup: async function complete_setup(splunk_js_sdk_service) {
                var app_name = "developer_guidance_setup_view";
                var configuration_file_name = "app";
                var stanza_name = "install";
                var properties_to_update = {
                    is_configured: "true",
                };

                await this.update_configuration_file(
                    splunk_js_sdk_service,
                    configuration_file_name,
                    stanza_name,
                    properties_to_update,
                );
            },

            reload_splunk_app: async function reload_splunk_app(
                splunk_js_sdk_service,
                app_name,
            ) {
                var splunk_js_sdk_apps = splunk_js_sdk_service.apps();
                await splunk_js_sdk_apps.fetch();

                var current_app = splunk_js_sdk_apps.item(app_name);
                current_app.reload();
            },

            // ----------------------------------
            // Splunk JS SDK Helpers
            // ----------------------------------
            // ---------------------
            // Process Helpers
            // ---------------------
            update_configuration_file: async function update_configuration_file(
                splunk_js_sdk_service,
                configuration_file_name,
                stanza_name,
                properties,
            ) {
                // Retrieve the accessor used to get a configuration file
                var splunk_js_sdk_service_configurations = splunk_js_sdk_service.configurations(
                    {
                        // Name space information not provided
                    },
                );
                await splunk_js_sdk_service_configurations.fetch();

                // Check for the existence of the configuration file being editect
                var does_configuration_file_exist = this.does_configuration_file_exist(
                    splunk_js_sdk_service_configurations,
                    configuration_file_name,
                );

                // If the configuration file doesn't exist, create it
                if (!does_configuration_file_exist) {
                    await this.create_configuration_file(
                        splunk_js_sdk_service_configurations,
                        configuration_file_name,
                    );
                }

                // Retrieves the configuration file accessor
                var configuration_file_accessor = this.get_configuration_file(
                    splunk_js_sdk_service_configurations,
                    configuration_file_name,
                );
                await configuration_file_accessor.fetch();

                // Checks to see if the stanza where the inputs will be
                // stored exist
                var does_stanza_exist = this.does_stanza_exist(
                    configuration_file_accessor,
                    stanza_name,
                );

                // If the configuration stanza doesn't exist, create it
                if (!does_stanza_exist) {
                    await this.create_stanza(configuration_file_accessor, stanza_name);
                }
                // Need to update the information after the creation of the stanza
                await configuration_file_accessor.fetch();

                // Retrieves the configuration stanza accessor
                var configuration_stanza_accessor = this.get_configuration_file_stanza(
                    configuration_file_accessor,
                    stanza_name,
                );
                await configuration_stanza_accessor.fetch();

                // We don't care if the stanza property does or doesn't exist
                // This is because we can use the
                // configurationStanza.update() function to create and
                // change the information of a property
                await this.update_stanza_properties(
                    configuration_stanza_accessor,
                    properties,
                );
            },

            // ---------------------
            // Existence Functions
            // ---------------------
            does_configuration_file_exist: function does_configuration_file_exist(
                configurations_accessor,
                configuration_file_name,
            ) {
                var was_configuration_file_found = false;

                var configuration_files_found = configurations_accessor.list();
                for (var index = 0; index < configuration_files_found.length; index++) {
                    var configuration_file_name_found =
                        configuration_files_found[index].name;
                    if (configuration_file_name_found === configuration_file_name) {
                        was_configuration_file_found = true;
                    }
                }

                return was_configuration_file_found;
            },

            does_stanza_exist: function does_stanza_exist(
                configuration_file_accessor,
                stanza_name,
            ) {
                var was_stanza_found = false;

                var stanzas_found = configuration_file_accessor.list();
                for (var index = 0; index < stanzas_found.length; index++) {
                    var stanza_found = stanzas_found[index].name;
                    if (stanza_found === stanza_name) {
                        was_stanza_found = true;
                    }
                }

                return was_stanza_found;
            },

            does_stanza_property_exist: function does_stanza_property_exist(
                configuration_stanza_accessor,
                property_name,
            ) {
                var was_property_found = false;

                for (const [key, value] of Object.entries(
                    configuration_stanza_accessor.properties(),
                )) {
                    if (key === property_name) {
                        was_property_found = true;
                    }
                }

                return was_property_found;
            },

            does_storage_password_exist: function does_storage_password_exist(
                storage_passwords_accessor,
                realm_name,
                username,
            ) {
                storage_passwords = storage_passwords_accessor.list();
                storage_passwords_found = [];

                for (var index = 0; index < storage_passwords.length; index++) {
                    storage_password = storage_passwords[index];
                    storage_password_stanza_name = storage_password.name;
                    storage_passwords_found.push(storage_password);
                }
                var does_storage_password_exist = storage_passwords_found.length > 0;

                return does_storage_password_exist;
            },

            // ---------------------
            // Retrieval Functions
            // ---------------------
            get_configuration_file: function get_configuration_file(
                configurations_accessor,
                configuration_file_name,
            ) {
                var configuration_file_accessor = configurations_accessor.item(
                    configuration_file_name,
                    {
                        // Name space information not provided
                    },
                );

                return configuration_file_accessor;
            },

            get_configuration_file_stanza: function get_configuration_file_stanza(
                configuration_file_accessor,
                configuration_stanza_name,
            ) {
                var configuration_stanza_accessor = configuration_file_accessor.item(
                    configuration_stanza_name,
                    {
                        // Name space information not provided
                    },
                );

                return configuration_stanza_accessor;
            },

            get_configuration_file_stanza_property: function get_configuration_file_stanza_property(
                configuration_file_accessor,
                configuration_file_name,
            ) {
                return null;
            },

            // ---------------------
            // Creation Functions
            // ---------------------
            create_splunk_js_sdk_service: function create_splunk_js_sdk_service(
                splunk_js_sdk,
                application_name_space,
            ) {
                var http = new splunk_js_sdk.SplunkWebHttp();

                var splunk_js_sdk_service = new splunk_js_sdk.Service(
                    http,
                    application_name_space,
                );

                return splunk_js_sdk_service;
            },

            create_configuration_file: function create_configuration_file(
                configurations_accessor,
                configuration_file_name,
            ) {
                var parent_context = this;

                return configurations_accessor.create(configuration_file_name, function(
                    error_response,
                    created_file,
                ) {
                    // Do nothing
                });
            },

            create_stanza: function create_stanza(
                configuration_file_accessor,
                new_stanza_name,
            ) {
                var parent_context = this;

                return configuration_file_accessor.create(new_stanza_name, function(
                    error_response,
                    created_stanza,
                ) {
                    // Do nothing
                });
            },

            update_stanza_properties: function update_stanza_properties(
                configuration_stanza_accessor,
                new_stanza_properties,
            ) {
                var parent_context = this;

                return configuration_stanza_accessor.update(
                    new_stanza_properties,
                    function(error_response, entity) {
                        // Do nothing
                    },
                );
            },

            create_storage_password_stanza: function create_storage_password_stanza(
                splunk_js_sdk_service_storage_passwords,
                realm,
                username,
                value_to_encrypt,
            ) {
                var parent_context = this;

                return splunk_js_sdk_service_storage_passwords.create(
                    {
                        name: username,
                        password: value_to_encrypt,
                        realm: realm,
                    },
                    function(error_response, response) {
                        // Do nothing
                    },
                );
            },

            // ----------------------------------
            // Deletion Methods
            // ----------------------------------
            delete_storage_password: function delete_storage_password(
                storage_passwords_accessor,
                realm,
                username,
            ) {
                return storage_passwords_accessor.del(realm + ":" + username + ":");
            },

            // ----------------------------------
            // Input Cleaning and Checking
            // ----------------------------------
            sanitize_string: function sanitize_string(string_to_sanitize) {
                var sanitized_string = string_to_sanitize.trim();

                return sanitized_string;
            },

            validate_api_url_input: function validate_api_url_input(hostname) {
                var error_messages = [];

                var is_string_empty = typeof hostname === "undefined" || hostname === "";
                var does_string_start_with_http_protocol = hostname.startsWith("http://");
                var does_string_start_with_https_protocol = hostname.startsWith(
                    "https://",
                );

                if (is_string_empty) {
                    error_message =
                        "The `API URL` specified was empty. Please provide" + " a value.";
                    error_messages.push(error_message);
                }
                if (does_string_start_with_http_protocol) {
                    error_message =
                        "The `API URL` specified is using `http://` at the" +
                        " beginning of it. Please remove the `http://` and" +
                        " enter the url with out it in `API URL` field.";
                    error_messages.push(error_message);
                }
                if (does_string_start_with_https_protocol) {
                    error_message =
                        "The `API URL` specified is using `https://` at the" +
                        " beginning of it. Please remove the `https://` and" +
                        " enter the url with out it in `API URL` field.";
                    error_messages.push(error_message);
                }

                return error_messages;
            },

            validate_api_key_input: function validate_api_key_input(api_key) {
                var error_messages = [];

                var is_string_empty = typeof api_key === "undefined" || api_key === "";

                if (is_string_empty) {
                    error_message =
                        "The `API Key` specified was empty. Please provide" + " a value.";
                    error_messages.push(error_message);
                }

                return error_messages;
            },

            validate_inputs: function validate_inputs(hostname, api_key) {
                var error_messages = [];

                var api_url_errors = this.validate_api_url_input(hostname);
                var api_key_errors = this.validate_api_key_input(api_key);

                error_messages = error_messages.concat(api_url_errors);
                error_messages = error_messages.concat(api_key_errors);

                return error_messages;
            },

            // ----------------------------------
            // GUI Helpers
            // ----------------------------------
            extract_error_messages: function extract_error_messages(error_messages) {
                // A helper function to extract error messages

                // Expects an array of messages
                // [
                //     {
                //         type: the_specific_error_type_found,
                //         text: the_specific_reason_for_the_error,
                //     },
                //     ...
                // ]

                var error_messages_to_display = [];
                for (var index = 0; index < error_messages.length; index++) {
                    error_message = error_messages[index];
                    error_message_to_display =
                        error_message.type + ": " + error_message.text;
                    error_messages_to_display.push(error_message_to_display);
                }

                return error_messages_to_display;
            },

            redirect_to_splunk_app_homepage: function redirect_to_splunk_app_homepage(
                app_name,
            ) {
                var redirect_url = "/app/" + app_name;

                window.location.href = redirect_url;
            },

            // ----------------------------------
            // Display Functions
            // ----------------------------------
            display_error_output: function display_error_output(error_messages) {
                // Hides the element if no messages, shows if any messages exist
                var did_error_messages_occur = error_messages.length > 0;

                var error_output_element = jquery(".setup.container .error.output");

                if (did_error_messages_occur) {
                    var new_error_output_string = "";
                    new_error_output_string += "<ul>";
                    for (var index = 0; index < error_messages.length; index++) {
                        new_error_output_string +=
                            "<li>" + error_messages[index] + "</li>";
                    }
                    new_error_output_string += "</ul>";

                    error_output_element.html(new_error_output_string);
                    error_output_element.stop();
                    error_output_element.fadeIn();
                } else {
                    error_output_element.stop();
                    error_output_element.fadeOut({
                        complete: function() {
                            error_output_element.html("");
                        },
                    });
                }
            },

            get_template: function get_template() {
                template_string =
                    "<div class='title'>" +
                    "    <h1>Welcome to Your Setup Page!</h1>" +
                    "</div>" +
                    "<div class='setup container'>" +
                    "    <div class='left'>" +
                    "        <h2>Overview</h2>" +
                    "        This setup view will create/modify three files in the local directory of this Splunk App." +
                    "        <br/>" +
                    "        <br/>" +
                    "        Splunk App Directory Path: `$SPLUNK_HOME/etc/apps/developer_guidance_setup_view/local/`" +
                    "        <ul>" +
                    "            <li>app.conf" +
                    "                <ul>" +
                    "                    <li>Sets the [install] stanza's `is_configured` property to `true`</li>" +
                    "                </ul>" +
                    "            </li>" +
                    "            <li>passwords.conf" +
                    "                <ul>" +
                    "                    <li>Creates and encrypts the API key, resulting in a new passwords.conf stanza.</li>" +
                    "                </ul>" +
                    "            </li>" +
                    "            <li>setup_view_example.conf" +
                    "                <ul>" +
                    "                    <li>Creates a custom conf file to manage Splunk App specific settings</li>" +
                    "                    <li>Creates the stanza [example_stanza]</li>" +
                    "                    <li>Creates the property `api_url` in the [example_stanza] and assigns the `API URL` to it</li>" +
                    "                </ul>" +
                    "            </li>" +
                    "        </ul>" +
                    "        <h2>Setup Properties</h2>" +
                    "        <div class='field api_url'>" +
                    "            <div class='title'>" +
                    "                <div>" +
                    "                    <h3>API URL:</h3>" +
                    "                    Please specify the url that will be used for API requests." +
                    "                </div>" +
                    "            </div>" +
                    "            </br>" +
                    "            <div class='user_input'>" +
                    "                <div class='protocol'>" +
                    "                    https://" +
                    "                </div>" +
                    "                <div class='text'>" +
                    "                    <input type='text' name='api_url' placeholder='example.com'></input>" +
                    "                </div>" +
                    "            </div>" +
                    "        </div>" +
                    "        <div class='field api_key'>" +
                    "            <div class='title'>" +
                    "                <h3>API Key:</h3>" +
                    "                Please specify the API Key that will be used to authenticate to the API." +
                    "            </div>" +
                    "            </br>" +
                    "            <div class='user_input'>" +
                    "                <div class='text'>" +
                    "                    <input type='text' name='api_key' placeholder='12345'></input>" +
                    "                </div>" +
                    "            </div>" +
                    "        </div>" +
                    "        <h2>Complete the Setup</h2>" +
                    "        <div>" +
                    "            Please press the 'Perform Setup` button below to complete the Splunk App setup." +
                    "        </div>" +
                    "        <br/>" +
                    "        <div>" +
                    "            <button name='setup_button' class='setup_button'>" +
                    "                Perform Setup" +
                    "            </button>" +
                    "        </div>" +
                    "        <br/>" +
                    "        <div class='error output'>" +
                    "        </div>" +
                    "    </div>" +
                    "    <div class='right'>" +
                    "        <h2>Implementation Details</h2>" +
                    "        <div class='description'>" +
                    "            <h3>Overview</h3>" +
                    "            This is a setup view that is intended to serve as a point of reference for Splunk Developers." +
                    "            </br>" +
                    "            This has been created using Application Certification approved best practices." +
                    "            <br/>" +
                    "            <h3>Splunk Techniques Used</h3>" +
                    "            <ul>" +
                    "                <li>Splunk Dashboards" +
                    "                    <ul>" +
                    "                        <li><a href='http://docs.splunk.com/Documentation/SplunkCloud/latest/Viz/PanelreferenceforSimplifiedXML'>API Documentation</a>  (docs.splunk.com)" +
                    "                    </ul>" +
                    "                </li>" +
                    "                <li>Splunk Setup View" +
                    "                    <ul>" +
                    "                        <li><a href='http://docs.splunk.com/Documentation/Splunk/6.6.3/admin/Appconf#.5Bui.5D'>app.conf Specification</a>" +
                    "                    </ul>" +
                    "                </li>" +
                    "                <li>Splunk Web Framework" +
                    "                    <ul>" +
                    "                        <li><a href='http://docs.splunk.com/Documentation/WebFramework'>API Documentation</a> (docs.splunk.com)" +
                    "                        <li><a href='http://dev.splunk.com/webframework'>Main Website</a> (dev.splunk.com)" +
                    "                    </ul>" +
                    "                </li>" +
                    "            </ul>" +
                    "            <h3>Technology Used</h3>" +
                    "            <ul>" +
                    "                <li>CSS</li>" +
                    "                <li>HTML</li>" +
                    "                <li>JavaScript" +
                    "                    <ul>" +
                    "                        <li>Backbone JS" +
                    "                            <ul>" +
                    "                                <li><a href='http://backbonejs.org/'>Main Website</a></li>" +
                    "                                <li><a href='https://github.com/jashkenas/backbone/'>On GitHub</a></li>" +
                    "                                <li><a href='http://backbonejs.org/#View'>Views</a> are the only feature used</li>" +
                    "                            </ul>" +
                    "                        </li>" +
                    "                        <li>JQuery" +
                    "                            <ul>" +
                    "                                <li><a href='http://jquery.com/'>Main Website</a>" +
                    "                                    <li><a href='https://github.com/jquery/jquery/'>On GitHub</a>" +
                    "                            </ul>" +
                    "                            </li>" +
                    "                            <li>Splunk JavaScript Software Development Kit" +
                    "                                <ul>" +
                    "                                    <li><a href='http://docs.splunk.com/Documentation/JavaScriptSDK'>API Documentation</a> (docs.splunk.com)</li>" +
                    "                                    <li><a href='https://github.com/splunk/splunk-sdk-javascript'>On GitHub</a></li>" +
                    "                                    <li><a href='http://dev.splunk.com/javascript'>Main Website</a> (dev.splunk.com)</li>" +
                    "                                </ul>" +
                    "                            </li>" +
                    "                    </ul>" +
                    "                    </li>" +
                    "            </ul>" +
                    "            <br/>" +
                    "        </div>" +
                    "    </div>" +
                    "</div>";

                return template_string;
            },
        }); // End of ExampleView class declaration

        return ExampleView;
    }, // End of require asynchronous module definition function
); // End of require statement